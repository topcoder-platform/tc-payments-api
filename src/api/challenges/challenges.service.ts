import {
  includes,
  isEmpty,
  find,
  camelCase,
  groupBy,
  orderBy,
  uniqBy,
} from 'lodash';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ENV_CONFIG } from 'src/config';
import { Logger } from 'src/shared/global';
import {
  Challenge,
  ChallengeResource,
  ChallengeReview,
  Prize,
  PrizeType,
  ResourceRole,
  Winner,
} from './models';
import { BillingAccountsService } from 'src/shared/topcoder/billing-accounts.service';
import { TopcoderM2MService } from 'src/shared/topcoder/topcoder-m2m.service';
import { ChallengeStatuses } from 'src/dto/challenge.dto';
import { PaymentStatus } from 'src/dto/payment.dto';
import {
  CHALLENGE_BUDGET_SYNC_SKIP_ATTRIBUTE,
  WinningsService,
} from '../winnings/winnings.service';
import { WinningsCategory, WinningsType } from 'src/dto/winning.dto';
import { WinningsRepository } from '../repository/winnings.repo';
import { PrismaService } from 'src/shared/global/prisma.service';
import { isTestChallenge } from 'src/shared/topcoder/challenges.service';

interface PaymentPayload {
  handle: string;
  amount: number;
  userId: string;
  type: WinningsCategory;
  currency: PrizeType;
  description?: string;
  status?: PaymentStatus;
}

const placeToOrdinal = (place: number) => {
  if (place === 1) return '1st';
  if (place === 2) return '2nd';
  if (place === 3) return '3rd';

  return `${place}th`;
};

const PAYMENT_TYPE_METADATA_NAME = 'payment_type';
const PAYMENT_TYPE_TO_CATEGORY: Record<string, WinningsCategory> = {
  taas: WinningsCategory.TAAS_PAYMENT,
  topgear: WinningsCategory.TOPGEAR_PAYMENT,
};
const OWED_TASK_PAYMENT_CATEGORIES = new Set<WinningsCategory>([
  WinningsCategory.TAAS_PAYMENT,
  WinningsCategory.COPILOT_PAYMENT,
  WinningsCategory.TASK_COPILOT_PAYMENT,
]);

const CANCELLED_CHALLENGE_STATUSES = [
  ChallengeStatuses.Canceled,
  ChallengeStatuses.CancelledFailedReview,
  ChallengeStatuses.CancelledFailedScreening,
  ChallengeStatuses.CancelledZeroSubmissions,
  ChallengeStatuses.CancelledWinnerUnresponsive,
  ChallengeStatuses.CancelledClientRequest,
  ChallengeStatuses.CancelledRequirementsInfeasible,
  ChallengeStatuses.CancelledZeroRegistrations,
  ChallengeStatuses.CancelledPaymentFailed,
].map((status) => status.toLowerCase());

const DESIGN_TRACK = 'DESIGN';
const SCREENING_PHASE_NAME = 'screening';

const {
  TOPCODER_API_V6_BASE_URL: TC_API_BASE,
  TGBillingAccounts,
  // Design challenge screeners are paid this flat fee, regardless of the
  // payment coefficients configured on the challenge reviewer entry.
  DESIGN_SCREENER_FEE,
} = ENV_CONFIG;

/**
 * Determines whether a challenge status represents a cancelled challenge.
 *
 * @param status Challenge status returned by challenge-api-v6.
 * @returns True when the status is one of the cancelled challenge states used
 * by challenge-api-v6.
 */
function isCancelledChallengeStatus(status?: string): boolean {
  return status
    ? CANCELLED_CHALLENGE_STATUSES.includes(status.toLowerCase())
    : false;
}

/**
 * Determines whether a challenge belongs to the Design track.
 *
 * @param track Challenge track display value or token returned by challenge-api-v6.
 * @returns True when the track is the Design track.
 */
function isDesignTrack(track?: string): boolean {
  return (track ?? '').trim().toUpperCase() === DESIGN_TRACK;
}

/**
 * Determines whether a challenge phase is the screening phase handled by the
 * challenge screener.
 *
 * @param phaseName Phase name returned by challenge-api-v6.
 * @returns True when the phase is the screening phase.
 */
function isScreeningPhase(phaseName?: string): boolean {
  return (phaseName ?? '').trim().toLowerCase() === SCREENING_PHASE_NAME;
}

@Injectable()
export class ChallengesService {
  private readonly logger = new Logger(ChallengesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly m2MService: TopcoderM2MService,
    private readonly baService: BillingAccountsService,
    private readonly winningsService: WinningsService,
    private readonly winningsRepo: WinningsRepository,
  ) {}

  private getMetadataPaymentCategory(
    challenge: Challenge,
  ): WinningsCategory | undefined {
    const metadataPaymentCategory = challenge.metadata?.find(
      ({ name, value }) =>
        name?.toLowerCase() === PAYMENT_TYPE_METADATA_NAME &&
        value &&
        PAYMENT_TYPE_TO_CATEGORY[value.toLowerCase()],
    );

    if (metadataPaymentCategory?.value) {
      return PAYMENT_TYPE_TO_CATEGORY[
        metadataPaymentCategory.value.toLowerCase()
      ];
    }

    return undefined;
  }

  private getDefaultWinnerCategory(challenge: Challenge): WinningsCategory {
    const metadataPaymentCategory = this.getMetadataPaymentCategory(challenge);

    if (metadataPaymentCategory) {
      return metadataPaymentCategory;
    }

    return challenge.task.isTask
      ? WinningsCategory.TASK_PAYMENT
      : WinningsCategory.CONTEST_PAYMENT;
  }

  private getReviewerPaymentCategory(
    challenge: Challenge,
    currency?: PrizeType,
  ): WinningsCategory {
    if (currency !== PrizeType.USD) {
      return WinningsCategory.POINTS_AWARD;
    }

    return this.getMetadataPaymentCategory(challenge) ===
      WinningsCategory.TOPGEAR_PAYMENT
      ? WinningsCategory.TOPGEAR_PAYMENT
      : WinningsCategory.REVIEW_BOARD_PAYMENT;
  }

  /**
   * Resolves the explicit payment status for task payments generated from
   * challenge-api-v6 challenge data.
   *
   * @param challenge Challenge details returned by challenge-api-v6.
   * @param category Winnings category selected for the generated payment.
   * @param currency Prize currency selected for the generated payment.
   * @returns OWED for USD TAAS task payments and task copilot payments,
   * ON_HOLD_ADMIN for other USD task payments, and undefined when standard
   * payout-readiness rules should apply.
   * @throws This method does not throw.
   */
  private getTaskPaymentStatus(
    challenge: Challenge,
    category: WinningsCategory,
    currency?: PrizeType,
  ): PaymentStatus | undefined {
    if (!challenge.task?.isTask || currency !== PrizeType.USD) {
      return undefined;
    }

    return OWED_TASK_PAYMENT_CATEGORIES.has(category)
      ? PaymentStatus.OWED
      : PaymentStatus.ON_HOLD_ADMIN;
  }

  async getChallenge(challengeId: string) {
    if (!isUUID(challengeId)) {
      throw new BadRequestException(
        'Invalid challengeId provided! Uuid expected!',
      );
    }

    const requestUrl = `${TC_API_BASE}/challenges/${encodeURIComponent(challengeId)}`;

    try {
      const challenge = await this.m2MService.m2mFetch<Challenge>(requestUrl);
      return challenge;
    } catch (e) {
      this.logger.error(
        `Challenge ${challengeId} details couldn't be fetched!`,
        e,
      );
    }
  }

  async getChallengeReviews(challengeId: string) {
    const requestUrl = `${TC_API_BASE}/reviews?challengeId=${challengeId}&status=COMPLETED&thin=true&perPage=9999`;

    try {
      const resposne = await this.m2MService.m2mFetch<{
        data: ChallengeReview[];
      }>(requestUrl);
      return resposne.data;
    } catch (e) {
      this.logger.error(
        `Challenge reviews couldn't be fetched for challenge ${challengeId}!`,
        e.message,
        e.status,
      );
    }
  }

  async getChallengeResources(challengeId: string) {
    try {
      const resources = await this.m2MService.m2mFetch<ChallengeResource[]>(
        `${TC_API_BASE}/resources?challengeId=${challengeId}`,
      );
      const resourceRoles = await this.m2MService.m2mFetch<ResourceRole[]>(
        `${TC_API_BASE}/resource-roles`,
      );

      const rolesMap = resourceRoles.reduce(
        (map, role) => {
          map[role.id] = camelCase(role.name);
          return map;
        },
        {} as { [key: string]: string },
      );

      return groupBy(resources, (r) => rolesMap[r.roleId]) as {
        [role: string]: ChallengeResource[];
      };
    } catch (e) {
      this.logger.error(
        `Challenge resources for challenge ${challengeId} couldn't be fetched!`,
        e,
      );
    }
  }

  generateWinnersPayments(
    challenge: Challenge,
    winners: Winner[],
    prizes: Prize[],
    type?: WinningsCategory,
  ): PaymentPayload[] {
    if (isCancelledChallengeStatus(challenge.status)) {
      return [];
    }

    const defaultCategory = this.getDefaultWinnerCategory(challenge);

    return winners.map((winner) => {
      const currency = prizes[winner.placement - 1].type;
      const winType =
        currency === PrizeType.USD
          ? (type ?? defaultCategory)
          : WinningsCategory.POINTS_AWARD;

      const status = this.getTaskPaymentStatus(challenge, winType, currency);

      return {
        handle: winner.handle,
        amount: prizes[winner.placement - 1].value,
        userId: winner.userId.toString(),
        type: winType,
        currency,
        ...(status ? { status } : {}),
        description:
          challenge.type === 'Task'
            ? challenge.name
            : `${challenge.name} - ${type === WinningsCategory.CONTEST_CHECKPOINT_PAYMENT ? 'Checkpoint ' : ''}${placeToOrdinal(winner.placement)} Place`,
      };
    });
  }

  generateCheckpointWinnersPayments(challenge: Challenge): PaymentPayload[] {
    const { prizeSets, checkpointWinners = [] } = challenge;

    // generate placement payments
    const checkpointPrizes = orderBy(
      find(prizeSets, { type: 'CHECKPOINT' })?.prizes,
      'value',
      'desc',
    );

    if ((checkpointPrizes?.length ?? 0) < (checkpointWinners?.length ?? 0)) {
      throw new Error(
        'Task has incorrect number of checkpoint prizes! There are more checkpoint winners than checkpoint prizes!',
      );
    }

    if (!checkpointPrizes?.length) {
      return [];
    }

    if (checkpointPrizes.length < checkpointWinners.length) {
      throw new Error(
        'Task has incorrect number of checkpoint prizes! There are more checkpoint winners than prizes!',
      );
    }

    return this.generateWinnersPayments(
      challenge,
      checkpointWinners,
      checkpointPrizes,
      WinningsCategory.CONTEST_CHECKPOINT_PAYMENT,
    );
  }

  generatePlacementWinnersPayments(challenge: Challenge): PaymentPayload[] {
    const { prizeSets, winners = [] } = challenge;

    // generate placement payments
    const placementPrizes = orderBy(
      find(prizeSets, { type: 'PLACEMENT' })?.prizes,
      'value',
      'desc',
    );

    if (placementPrizes.length < winners.length) {
      throw new Error(
        'Task has incorrect number of placement prizes! There are more winners than prizes!',
      );
    }

    return this.generateWinnersPayments(challenge, winners, placementPrizes);
  }

  generateCopilotPayment(
    challenge: Challenge,
    copilots: ChallengeResource[],
  ): PaymentPayload[] {
    const copilotPrizes =
      find(challenge.prizeSets, { type: 'COPILOT' })?.prizes ?? [];

    if (!copilotPrizes.length || isCancelledChallengeStatus(challenge.status)) {
      return [];
    }

    const placementPrizes = orderBy(
      find(challenge.prizeSets, { type: 'PLACEMENT' })?.prizes,
      'value',
      'desc',
    );

    if (placementPrizes[0]?.type !== PrizeType.USD) {
      const prizeType = placementPrizes[0].type;
      this.logger.log(
        `Skipping copilot payments generation for challenge ${challenge.id} with "${prizeType}" winning prize!`,
      );
      return [];
    }

    if (!copilots?.length) {
      throw new Error('Task has a copilot prize but no copilot assigned!');
    }

    const copilotPrize = copilotPrizes[0];
    const currency = copilotPrize.type;
    const winType =
      currency === PrizeType.USD
        ? WinningsCategory.COPILOT_PAYMENT
        : WinningsCategory.POINTS_AWARD;
    return copilots.map((copilot) => ({
      handle: copilot.memberHandle,
      amount: copilotPrizes[0].value,
      userId: copilot.memberId.toString(),
      type: winType,
      currency,
      description: `${challenge.name} - Copilot payment`,
    }));
  }

  async generateReviewersPayments(
    challenge: Challenge,
    reviewers: ChallengeResource[],
  ): Promise<PaymentPayload[]> {
    const placementPrizes = orderBy(
      find(challenge.prizeSets, { type: 'PLACEMENT' })?.prizes,
      'value',
      'desc',
    );

    if (placementPrizes[0]?.type !== PrizeType.USD) {
      const prizeType = placementPrizes[0].type;
      this.logger.log(
        `Skipping reviewers payments generation for challenge ${challenge.id} with "${prizeType}" winning prize!`,
      );
      return [];
    }

    // generate reviewer payments
    const firstPlacePrize = placementPrizes?.[0]?.value ?? 0;
    const hasMemberReviewers = find(challenge.reviewers, {
      isMemberReview: true,
    });

    const challengeReviews = await this.getChallengeReviews(challenge.id);

    if (
      !hasMemberReviewers ||
      !reviewers?.length ||
      !challengeReviews?.length
    ) {
      return [];
    }

    // For each challenge resource reviewer (can be main reviewer, approver, screener, etc)
    // we get the reviewer's reviews
    // and group them by phaseId
    // based on the phaseId, we're fetching the correct challenge reviewer type (which has assigned payments coefficients)
    // then we create the reviewe's payments for each phase based on the number of reviews done on each phase and the type of challenge reviewer assigned
    return reviewers
      .map((reviewer) => {
        // Find all reviews that were performed by this reviewer (case-insensitive match)
        const reviews = challengeReviews
          .filter(
            (r) =>
              r.reviewerHandle.toLowerCase() ===
              reviewer.memberHandle.toLowerCase(),
          )
          .map((r) => {
            const challengePhase = find(challenge.phases, { id: r.phaseId });

            if (!challengePhase) {
              throw new Error(
                `Failed to find challenge phase for review phase: ${r.phaseName} (${r.phaseId})`,
              );
            }

            return {
              ...r,
              // Find the corresponding phase object in the challenge definition using its id
              phaseId: challengePhase?.phaseId,
            };
          });

        // Group the reviews by their associated phaseId
        return Object.entries(groupBy(reviews, 'phaseId')).map(
          ([phaseId, phaseReviews]) => {
            // Find the reviewer entry in the challenge's reviewer list for this phase
            // (be sure to exclude ai reviews)
            const challengeReviewer = find(challenge.reviewers, {
              isMemberReview: true,
              phaseId,
            });

            if (!challengeReviewer) {
              throw new Error(
                `Failed to find challenge reviewer for phase: ${phaseReviews[0].phaseName} (${phaseId})`,
              );
            }

            const placementPrize = placementPrizes?.[0];
            const currency = placementPrize?.type;
            const winType = this.getReviewerPaymentCategory(
              challenge,
              currency,
            );

            const status = this.getTaskPaymentStatus(
              challenge,
              winType,
              currency,
            );

            // Design challenge screeners are always paid the flat screener fee
            // instead of the coefficient based amount, which resolves to $0
            // when no payment coefficients are configured for the phase.
            const isDesignScreening =
              currency === PrizeType.USD &&
              isDesignTrack(challenge.track) &&
              isScreeningPhase(phaseReviews[0].phaseName);

            const amount = isDesignScreening
              ? DESIGN_SCREENER_FEE
              : Math.ceil(
                  (challengeReviewer.fixedAmount ?? 0) +
                    (challengeReviewer.baseCoefficient ?? 0) * firstPlacePrize +
                    (challengeReviewer.incrementalCoefficient ?? 0) *
                      firstPlacePrize *
                      phaseReviews.length,
                );

            return {
              handle: reviewer.memberHandle,
              userId: reviewer.memberId.toString(),
              amount,
              type: winType,
              currency: placementPrizes?.[0]?.type ?? PrizeType.USD,
              ...(status ? { status } : {}),
              description: `${challenge.name} - ${phaseReviews[0].phaseName}`,
            };
          },
        );
      })
      .flat();
  }

  async getChallengePayments(challenge: Challenge) {
    this.logger.log(
      `Generating payments for challenge ${challenge.name} (${challenge.id}).`,
    );

    const challengeResources = await this.getChallengeResources(challenge.id);

    if (!challengeResources || isEmpty(challengeResources)) {
      throw new Error('Missing challenge resources!');
    }

    const winnersPayments = this.generatePlacementWinnersPayments(challenge);
    const checkpointPayments =
      this.generateCheckpointWinnersPayments(challenge);
    const copilotPayments = this.generateCopilotPayment(
      challenge,
      challengeResources.copilot,
    );

    let reviewersPayments: PaymentPayload[] = [];
    try {
      reviewersPayments = await this.generateReviewersPayments(
        challenge,
        uniqBy(
          [
            ...(challengeResources.iterativeReviewer ?? []),
            ...(challengeResources.reviewer ?? []),
            ...(challengeResources.checkpointScreener ?? []),
            ...(challengeResources.checkpointReviewer ?? []),
            ...(challengeResources.screener ?? []),
            ...(challengeResources.approver ?? []),
          ],
          'memberId',
        ),
      );
    } catch (error) {
      this.logger.error(
        `Failed to generate reviewers payments for challenge ${challenge.id}!`,
        error.message,
      );
    }

    const payments: PaymentPayload[] = [
      ...winnersPayments,
      ...checkpointPayments,
      ...copilotPayments,
      ...reviewersPayments,
    ];

    const totalUsdAmount = payments.reduce(
      (sum, payment) =>
        sum + (payment.currency === PrizeType.USD ? payment.amount : 0),
      0,
    );

    return payments.map((payment) => {
      const paymentStatus =
        payment.status ??
        this.getTaskPaymentStatus(challenge, payment.type, payment.currency);

      return {
        winnerId: payment.userId.toString(),
        type:
          payment.currency === PrizeType.USD
            ? WinningsType.PAYMENT
            : WinningsType.POINTS,
        origin: 'Topcoder',
        category: payment.type,
        title: challenge.name,
        description: payment.description || challenge.name,
        externalId: challenge.id,
        ...(paymentStatus ? { status: paymentStatus } : {}),
        details: [
          {
            totalAmount: payment.amount,
            grossAmount: payment.amount,
            installmentNumber: 1,
            currency: payment.currency || PrizeType.USD,
            billingAccount: `${challenge.billing.billingAccountId}`,
            challengeFee: totalUsdAmount * challenge.billing.markup,
          },
        ],
        attributes: {
          billingAccountId: challenge.billing.billingAccountId,
          [CHALLENGE_BUDGET_SYNC_SKIP_ATTRIBUTE]: true,
          payroll: includes(
            TGBillingAccounts,
            parseInt(challenge.billing.billingAccountId),
          ),
        },
      };
    });
  }

  private async createPayments(challenge: Challenge, userId: string) {
    const existingPayments = (
      await this.winningsRepo.searchWinnings({
        externalIds: [challenge.id],
      })
    )?.data?.winnings;

    if (existingPayments?.length > 0) {
      this.logger.log(
        `Payments already exist for challenge ${challenge.id}, skipping payment generation`,
      );
      throw new Error(
        `Payments already exist for challenge ${challenge.id}, skipping payment generation`,
      );
    }

    const paymentTypes = [
      ...new Set(
        challenge.prizeSets
          .map((set) => set.prizes.map((prize) => prize.type))
          .flat(),
      ),
    ];

    // treat POINT as supported (persisted) payment type; other non-USD/POINT types are rewards
    const isSupportedPayment = paymentTypes.some(
      (type) => type === PrizeType.USD || type === PrizeType.POINT,
    );

    if (!isSupportedPayment) {
      this.logger.log(
        `Detected not supported payment type: ${paymentTypes.join(', ')}. Skipping payments generation for challenge ${challenge.name} (${challenge.id}).`,
      );
      return;
    }

    const payments = await this.getChallengePayments(challenge);
    // compute USD totals for BA validation/locking (POINT payments are persisted but not billed)
    const totalUsdAmount = payments.reduce(
      (sum, payment) =>
        sum +
        (payment.details[0].currency === PrizeType.USD
          ? payment.details[0].totalAmount
          : 0),
      0,
    );

    const baValidation = {
      challengeId: challenge.id,
      billingAccountId: +challenge.billing.billingAccountId,
      markup: challenge.billing.markup,
      status: challenge.status,
      totalPrizesInCents: totalUsdAmount * 100,
    };

    if (challenge.billing?.clientBillingRate != null) {
      baValidation.markup = challenge.billing.clientBillingRate;
    }

    await Promise.all(
      payments.map(async (p) => {
        try {
          await this.winningsService.createWinningWithPayments(
            p,
            userId,
            challenge,
          );
        } catch (e) {
          this.logger.log(
            `Failed to create winnings payment for user ${p.winnerId}!`,
            e,
          );
        }
      }),
    );

    this.logger.log('Task Completed. locking consumed budget', baValidation);
    await this.baService.lockConsumeAmount(baValidation);
  }

  /**
   * Creates the winnings and nested payments generated from a payable
   * challenge. Challenges explicitly marked with the exact metadata entry
   * `{ name: 'is_test_challenge', value: 'true' }` return before payment locks,
   * winnings, or billing-account budget records are created.
   *
   * @param challengeId Challenge UUID to load from challenge-api-v6.
   * @param userId Finance user responsible for the generated payment rows.
   * @returns A promise that resolves after payment creation, or immediately for
   * a test or fun challenge.
   * @throws Error when the challenge is missing, is not payable, or payment
   * generation fails; ConflictException when another generation lock exists.
   */
  async generateChallengePayments(challengeId: string, userId: string) {
    const challenge = await this.getChallenge(challengeId);
    this.logger.log(`Fetched challenge ${challengeId}`);

    if (!challenge) {
      this.logger.error(`Challenge not found: ${challengeId}`);
      throw new Error('Challenge not found!');
    }

    this.logger.log(
      `Challenge ${challenge.id} - "${challenge.name}" with status "${challenge.status}" retrieved`,
    );

    if (isTestChallenge(challenge)) {
      this.logger.log(
        `Skipping payment generation for test challenge ${challenge.id} (${challenge.name}).`,
      );
      return;
    }

    const isPayableStatus =
      challenge.status.toLowerCase() ===
        ChallengeStatuses.Completed.toLowerCase() ||
      isCancelledChallengeStatus(challenge.status);

    if (!isPayableStatus) {
      this.logger.error(
        `Challenge ${challenge.id} isn't in a payable status: ${challenge.status}`,
      );
      throw new Error("Challenge isn't in a payable status!");
    }

    if (challenge.funChallenge === true) {
      this.logger.log(
        `Skipping payment generation for fun challenge ${challenge.id} (${challenge.name}).`,
      );
      return;
    }

    // need to read for update (LOCK the rows)
    this.logger.log(`Attempting to acquire lock for challenge ${challenge.id}`);
    try {
      await this.prisma.challenge_lock.create({
        data: { external_id: challenge.id },
      });
      this.logger.log(`Lock acquired for challenge ${challenge.id}`);
    } catch (err: any) {
      if (err.code === 'P2002') {
        this.logger.log(`Challenge Lock already acquired for ${challenge.id}`);
        // P2002 = unique constraint failed → lock already exists
        throw new ConflictException(
          `Challenge Lock already acquired for ${challenge.id}`,
        );
      }
      this.logger.error(
        `Failed to acquire lock for challenge ${challenge.id}`,
        err.message ?? err,
      );
      throw err;
    }

    try {
      this.logger.log(
        `Starting payment creation for challenge ${challenge.id}`,
      );
      await this.createPayments(challenge, userId);
      this.logger.log(
        `Payment creation completed for challenge ${challenge.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Error while creating payments for challenge ${challenge.id}`,
        error.message ?? error,
      );
      if (
        error &&
        typeof error.message === 'string' &&
        error.message.includes('Lock already acquired')
      ) {
        this.logger.log(
          `Conflict detected while creating payments for ${challenge.id}`,
        );
        throw new ConflictException(
          'Another payment operation is in progress.',
        );
      } else {
        throw error;
      }
    } finally {
      try {
        const result = await this.prisma.challenge_lock.deleteMany({
          where: { external_id: challenge.id },
        });
        this.logger.log(
          `Released lock for challenge ${challenge.id}. Rows deleted: ${result.count}`,
        );
      } catch (releaseErr) {
        // swallow errors if lock was already released but log for observability
        this.logger.error(
          `Failed to release lock for challenge ${challenge.id}`,
          releaseErr.message ?? releaseErr,
        );
      }
    }
  }
}
