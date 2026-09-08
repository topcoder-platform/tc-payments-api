import { ChallengeStatuses } from '../../dto/challenge.dto';

jest.mock('src/config', () => ({
  ENV_CONFIG: {
    // Deliberately not the 100 default, so the tests prove the screener fee is
    // read from the environment config.
    DESIGN_SCREENER_FEE: 75,
    TGBillingAccounts: [],
    TOPCODER_API_V6_BASE_URL: 'https://api.topcoder-dev.com/v6',
  },
}));

jest.mock('src/shared/global', () => ({
  Logger: class {
    debug = jest.fn();

    error = jest.fn();

    info = jest.fn();

    log = jest.fn();

    warn = jest.fn();
  },
}));

import { ChallengesService } from './challenges.service';
import { PrizeType } from './models';
import { WinningsCategory } from 'src/dto/winning.dto';
import { PaymentStatus } from 'src/dto/payment.dto';
import { CHALLENGE_BUDGET_SYNC_SKIP_ATTRIBUTE } from '../winnings/winnings.service';

describe('ChallengesService', () => {
  it.each([
    {
      expectedToSkip: true,
      label: 'enabled',
      metadata: [{ name: 'is_test_challenge', value: 'true' }],
    },
    {
      expectedToSkip: false,
      label: 'disabled',
      metadata: [{ name: 'is_test_challenge', value: 'false' }],
    },
    {
      expectedToSkip: false,
      label: 'absent',
      metadata: undefined,
    },
    {
      expectedToSkip: false,
      label: 'uppercase value',
      metadata: [{ name: 'is_test_challenge', value: 'TRUE' }],
    },
    {
      expectedToSkip: false,
      label: 'non-string value',
      metadata: [{ name: 'is_test_challenge', value: true }],
    },
    {
      expectedToSkip: false,
      label: 'uppercase name',
      metadata: [{ name: 'IS_TEST_CHALLENGE', value: 'true' }],
    },
  ])(
    '$label test-challenge metadata: expectedToSkip=$expectedToSkip',
    async ({ expectedToSkip, metadata }) => {
      const prisma = {
        challenge_lock: {
          create: jest.fn().mockResolvedValue({}),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const service = new ChallengesService(
        prisma as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      const challenge = {
        id: '11111111-1111-1111-1111-111111111111',
        metadata,
        name: 'Payment exclusion test',
        status: ChallengeStatuses.Completed,
      };
      const createPaymentsSpy = jest
        .spyOn(service as any, 'createPayments')
        .mockResolvedValue(undefined);

      jest.spyOn(service, 'getChallenge').mockResolvedValue(challenge as any);

      await service.generateChallengePayments(challenge.id, 'test-user');

      expect(createPaymentsSpy).toHaveBeenCalledTimes(expectedToSkip ? 0 : 1);
      expect(prisma.challenge_lock.create).toHaveBeenCalledTimes(
        expectedToSkip ? 0 : 1,
      );
      expect(prisma.challenge_lock.deleteMany).toHaveBeenCalledTimes(
        expectedToSkip ? 0 : 1,
      );
    },
  );

  it('skips creating payments for fun challenges', async () => {
    const prisma = {
      challenge_lock: {
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    const service = new ChallengesService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const challenge = {
      funChallenge: true,
      id: '11111111-1111-1111-1111-111111111111',
      name: 'MM 163',
      status: ChallengeStatuses.Completed,
    };
    const createPaymentsSpy = jest
      .spyOn(service as any, 'createPayments')
      .mockResolvedValue(undefined);

    jest.spyOn(service, 'getChallenge').mockResolvedValue(challenge as any);

    await service.generateChallengePayments(
      '11111111-1111-1111-1111-111111111111',
      'test-user',
    );

    expect(createPaymentsSpy).not.toHaveBeenCalled();
    expect(prisma.challenge_lock.create).not.toHaveBeenCalled();
  });

  it('maps task challenges with taas metadata to TAAS_PAYMENT and OWED status', () => {
    const service = new ChallengesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const payments = service.generateWinnersPayments(
      {
        name: 'Task Mar 17',
        status: ChallengeStatuses.Completed,
        type: 'Task',
        task: { isTask: true },
        metadata: [{ name: 'payment_type', value: 'taas' }],
      } as any,
      [{ handle: 'tester', placement: 1, userId: 40158994 }],
      [{ type: PrizeType.USD, value: 500 }],
    );

    expect(payments).toEqual([
      expect.objectContaining({
        type: WinningsCategory.TAAS_PAYMENT,
        status: PaymentStatus.OWED,
      }),
    ]);
  });

  it('maps task challenges with topgear metadata to TOPGEAR_PAYMENT', () => {
    const service = new ChallengesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const payments = service.generateWinnersPayments(
      {
        name: 'Task Mar 17',
        status: ChallengeStatuses.Completed,
        type: 'Task',
        task: { isTask: true },
        metadata: [{ name: 'payment_type', value: 'topgear' }],
      } as any,
      [{ handle: 'tester', placement: 1, userId: 40158994 }],
      [{ type: PrizeType.USD, value: 500 }],
    );

    expect(payments).toEqual([
      expect.objectContaining({
        type: WinningsCategory.TOPGEAR_PAYMENT,
      }),
    ]);
  });

  it('maps reviewer payments to TOPGEAR_PAYMENT for topgear challenges', async () => {
    const service = new ChallengesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest.spyOn(service, 'getChallengeReviews').mockResolvedValue([
      {
        phaseId: 'phase-resource-1',
        phaseName: 'Review',
        reviewerHandle: 'reviewer1',
      },
    ] as any);

    const payments = await service.generateReviewersPayments(
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Topgear Review Challenge',
        metadata: [{ name: 'payment_type', value: 'topgear' }],
        prizeSets: [
          { type: 'PLACEMENT', prizes: [{ type: PrizeType.USD, value: 500 }] },
        ],
        reviewers: [
          {
            isMemberReview: true,
            phaseId: 'review-phase-1',
            fixedAmount: 10,
            baseCoefficient: 0.1,
            incrementalCoefficient: 0.05,
          },
        ],
        phases: [{ id: 'phase-resource-1', phaseId: 'review-phase-1' }],
      } as any,
      [
        {
          memberHandle: 'reviewer1',
          memberId: 123,
        },
      ] as any,
    );

    expect(payments).toEqual([
      expect.objectContaining({
        type: WinningsCategory.TOPGEAR_PAYMENT,
      }),
    ]);
  });

  it.each([
    {
      label: 'pays the configured screener fee for design challenge screening',
      track: 'Design',
      phaseName: 'Screening',
      expectedAmount: 75,
    },
    {
      label:
        'pays the configured screener fee for uppercase design track token',
      track: 'DESIGN',
      phaseName: 'Screening',
      expectedAmount: 75,
    },
    {
      label: 'keeps coefficient based amount for design challenge review',
      track: 'Design',
      phaseName: 'Review',
      expectedAmount: 10,
    },
    {
      label: 'keeps coefficient based amount for non-design screening',
      track: 'Development',
      phaseName: 'Screening',
      expectedAmount: 10,
    },
  ])('$label', async ({ track, phaseName, expectedAmount }) => {
    const service = new ChallengesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest.spyOn(service, 'getChallengeReviews').mockResolvedValue([
      {
        phaseId: 'phase-resource-1',
        phaseName,
        reviewerHandle: 'screener1',
      },
    ] as any);

    const payments = await service.generateReviewersPayments(
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Design Screening Challenge',
        track,
        prizeSets: [
          { type: 'PLACEMENT', prizes: [{ type: PrizeType.USD, value: 500 }] },
        ],
        reviewers: [
          {
            isMemberReview: true,
            phaseId: 'screening-phase-1',
            fixedAmount: 10,
          },
        ],
        phases: [{ id: 'phase-resource-1', phaseId: 'screening-phase-1' }],
      } as any,
      [
        {
          memberHandle: 'screener1',
          memberId: 123,
        },
      ] as any,
    );

    expect(payments).toEqual([
      expect.objectContaining({
        amount: expectedAmount,
        type: WinningsCategory.REVIEW_BOARD_PAYMENT,
      }),
    ]);
  });

  it('defaults TAAS task challenge winnings to OWED status', async () => {
    const service = new ChallengesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest
      .spyOn(service, 'getChallengeResources')
      .mockResolvedValue({ winner: [] });
    jest.spyOn(service, 'generatePlacementWinnersPayments').mockReturnValue([
      {
        userId: '40158994',
        amount: 500,
        type: WinningsCategory.TAAS_PAYMENT,
        currency: PrizeType.USD,
      },
    ] as any);
    jest
      .spyOn(service, 'generateCheckpointWinnersPayments')
      .mockReturnValue([]);
    jest.spyOn(service, 'generateCopilotPayment').mockReturnValue([]);
    jest.spyOn(service, 'generateReviewersPayments').mockResolvedValue([]);

    const winnings = await service.getChallengePayments({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'TAAS Task Challenge',
      type: 'Task',
      task: { isTask: true },
      billing: { billingAccountId: '1234', markup: 0.2 },
    } as any);

    expect(winnings).toEqual([
      expect.objectContaining({
        category: WinningsCategory.TAAS_PAYMENT,
        status: PaymentStatus.OWED,
      }),
    ]);
    expect(winnings[0].attributes).toMatchObject({
      [CHALLENGE_BUDGET_SYNC_SKIP_ATTRIBUTE]: true,
    });
  });

  it('defaults non-TAAS task challenge winnings to ON_HOLD_ADMIN status', async () => {
    const service = new ChallengesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest
      .spyOn(service, 'getChallengeResources')
      .mockResolvedValue({ winner: [] });
    jest.spyOn(service, 'generatePlacementWinnersPayments').mockReturnValue([
      {
        userId: '40158994',
        amount: 500,
        type: WinningsCategory.TASK_PAYMENT,
        currency: PrizeType.USD,
      },
    ] as any);
    jest
      .spyOn(service, 'generateCheckpointWinnersPayments')
      .mockReturnValue([]);
    jest.spyOn(service, 'generateCopilotPayment').mockReturnValue([]);
    jest.spyOn(service, 'generateReviewersPayments').mockResolvedValue([]);

    const winnings = await service.getChallengePayments({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Task Challenge',
      type: 'Task',
      task: { isTask: true },
      billing: { billingAccountId: '1234', markup: 0.2 },
    } as any);

    expect(winnings).toEqual([
      expect.objectContaining({
        status: PaymentStatus.ON_HOLD_ADMIN,
      }),
    ]);
    expect(winnings[0].attributes).toMatchObject({
      [CHALLENGE_BUDGET_SYNC_SKIP_ATTRIBUTE]: true,
    });
  });

  it.each([
    ['regular', undefined],
    ['TAAS', [{ name: 'payment_type', value: 'taas' }]],
    ['Topgear', [{ name: 'payment_type', value: 'topgear' }]],
  ])(
    'defaults %s task copilot payments to OWED status',
    async (_, metadata) => {
      const service = new ChallengesService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service, 'getChallengeResources').mockResolvedValue({
        copilot: [{ memberHandle: 'copilot', memberId: '40158995' }],
      } as any);
      jest.spyOn(service, 'getChallengeReviews').mockResolvedValue([]);

      const winnings = await service.getChallengePayments({
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Task Challenge',
        type: 'Task',
        task: { isTask: true },
        billing: { billingAccountId: '1234', markup: 0.2 },
        metadata,
        winners: [],
        checkpointWinners: [],
        reviewers: [],
        phases: [],
        prizeSets: [
          { type: 'PLACEMENT', prizes: [{ type: PrizeType.USD, value: 500 }] },
          { type: 'COPILOT', prizes: [{ type: PrizeType.USD, value: 100 }] },
        ],
      } as any);

      expect(winnings).toEqual([
        expect.objectContaining({
          category: WinningsCategory.COPILOT_PAYMENT,
          status: PaymentStatus.OWED,
          winnerId: '40158995',
        }),
      ]);
    },
  );

  it('does not force ON_HOLD_ADMIN status for non-task challenge winnings', async () => {
    const service = new ChallengesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest
      .spyOn(service, 'getChallengeResources')
      .mockResolvedValue({ winner: [] });
    jest.spyOn(service, 'generatePlacementWinnersPayments').mockReturnValue([
      {
        userId: '40158994',
        amount: 500,
        type: WinningsCategory.CONTEST_PAYMENT,
        currency: PrizeType.USD,
      },
    ] as any);
    jest
      .spyOn(service, 'generateCheckpointWinnersPayments')
      .mockReturnValue([]);
    jest.spyOn(service, 'generateCopilotPayment').mockReturnValue([]);
    jest.spyOn(service, 'generateReviewersPayments').mockResolvedValue([]);

    const winnings = await service.getChallengePayments({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Marathon Match',
      type: 'Challenge',
      task: { isTask: false },
      billing: { billingAccountId: '1234', markup: 0.2 },
    } as any);

    expect(winnings).toEqual([
      expect.not.objectContaining({
        status: PaymentStatus.ON_HOLD_ADMIN,
      }),
    ]);
  });

  it('skips winner payments for cancelled challenges', () => {
    const service = new ChallengesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const payments = service.generateWinnersPayments(
      {
        name: 'Cancelled Challenge',
        status: ChallengeStatuses.CancelledClientRequest,
        task: { isTask: false },
        type: 'Challenge',
      } as any,
      [{ handle: 'winner', placement: 1, userId: 40158994 }],
      [{ type: PrizeType.USD, value: 500 }],
    );

    expect(payments).toEqual([]);
  });

  it('skips copilot payments for cancelled challenges', () => {
    const service = new ChallengesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const payments = service.generateCopilotPayment(
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Cancelled Challenge',
        prizeSets: [
          { prizes: [{ type: PrizeType.USD, value: 100 }], type: 'COPILOT' },
          { prizes: [{ type: PrizeType.USD, value: 500 }], type: 'PLACEMENT' },
        ],
        status: ChallengeStatuses.CancelledClientRequest,
      } as any,
      [{ memberHandle: 'copilot', memberId: '40158994' }] as any,
    );

    expect(payments).toEqual([]);
  });

  it('allows cancelled challenges with no generated payments to release budget locks', async () => {
    const prisma = {
      challenge_lock: {
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const baService = {
      lockConsumeAmount: jest.fn().mockResolvedValue(undefined),
    };
    const winningsService = {
      createWinningWithPayments: jest.fn(),
    };
    const winningsRepo = {
      searchWinnings: jest.fn().mockResolvedValue({ data: { winnings: [] } }),
    };
    const service = new ChallengesService(
      prisma as any,
      {} as any,
      baService as any,
      winningsService as any,
      winningsRepo as any,
    );
    const challenge = {
      billing: { billingAccountId: '80001012', markup: 0.1 },
      funChallenge: false,
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Cancelled Challenge',
      prizeSets: [
        { prizes: [{ type: PrizeType.USD, value: 500 }], type: 'PLACEMENT' },
      ],
      reviewers: [],
      status: ChallengeStatuses.CancelledClientRequest,
      task: { isTask: false },
      type: 'Challenge',
    };

    jest.spyOn(service, 'getChallenge').mockResolvedValue(challenge as any);
    jest.spyOn(service, 'getChallengeResources').mockResolvedValue({
      reviewer: [{ memberHandle: 'reviewer', memberId: '40158995' }],
    } as any);
    jest.spyOn(service, 'getChallengeReviews').mockResolvedValue([]);

    await service.generateChallengePayments(
      '11111111-1111-1111-1111-111111111111',
      'test-user',
    );

    expect(winningsService.createWinningWithPayments).not.toHaveBeenCalled();
    expect(baService.lockConsumeAmount).toHaveBeenCalledWith(
      expect.objectContaining({
        billingAccountId: 80001012,
        challengeId: '11111111-1111-1111-1111-111111111111',
        markup: 0.1,
        status: ChallengeStatuses.CancelledClientRequest,
        totalPrizesInCents: 0,
      }),
    );
  });
});
