# Environment Variables Documentation

## Table of Contents

- [Overview](#overview)
- [Required Variables](#required-variables)
- [Optional Variables](#optional-variables)
- [Setup Guide](#setup-guide)

## Overview

The Topcoder Finance API requires several environment variables for proper configuration. These variables control database connections, external service integrations, authentication, and application behavior.

All environment variables should be defined in a `.env` file in the project root or set in the deployment environment.

## Required Variables

### Database Configuration

#### `DATABASE_URL`

- **Type**: String (Connection URL)
- **Required**: Yes
- **Description**: PostgreSQL database connection string
- **Format**: `postgresql://{username}:{password}@{host}:{port}/{database}?sslmode={mode}`
- **Example**: `postgresql://topcoderuser:password@localhost:5434/walletdb?sslmode=disable`
- **Notes**:
  - Used by Prisma for database connections
  - Include SSL mode for production environments
  - Connection pooling is handled by Prisma

### Auth0 Configuration

#### `AUTH0_CLIENT_ID`

- **Type**: String (UUID)
- **Required**: Yes
- **Description**: Auth0 client ID for user authentication
- **Notes**: Used to validate user JWT tokens
- **How to get**: Auth0 Dashboard → Applications → Your Application → Client ID

#### `AUTH0_CERT`

- **Type**: String (RSA Public Key)
- **Required**: Yes
- **Description**: RSA public key for JWT signature verification
- **Format**: PEM format with BEGIN/END markers
- **How to get**: Auth0 Dashboard → Applications → Advanced Settings → Certificates

#### `AUTH0_M2M_CLIENT_ID`

- **Type**: String (UUID)
- **Required**: Yes
- **Description**: Auth0 Machine-to-Machine client ID
- **Notes**: Used for M2M authentication with Topcoder APIs
- **How to get**: Auth0 Dashboard → Applications → Machine to Machine Application → Client ID

#### `AUTH0_M2M_SECRET`

- **Type**: String
- **Required**: Yes
- **Description**: Auth0 M2M client secret
- **Example**: `your-m2m-secret-here`
- **Notes**: Keep this secret secure, never commit to version control
- **How to get**: Auth0 Dashboard → Applications → Machine to Machine Application → Client Secret

#### `AUTH0_M2M_AUDIENCE`

- **Type**: String (URL)
- **Required**: Yes
- **Description**: Auth0 M2M API audience identifier
- **Example**: `https://m2m.topcoder-dev.com/`
- **Notes**: Identifies the API that the M2M token is for

#### `AUTH0_M2M_TOKEN_URL`

- **Type**: String (URL)
- **Required**: Yes
- **Description**: Auth0 token endpoint for M2M authentication
- **Example**: `https://topcoder-dev.auth0.com/oauth/token`
- **Format**: `https://{auth0-domain}/oauth/token`

#### `AUTH0_M2M_GRANT_TYPE`

- **Type**: String
- **Required**: Yes
- **Description**: OAuth2 grant type for M2M authentication
- **Example**: `client_credentials`
- **Default**: `client_credentials`
- **Notes**: Should always be `client_credentials` for M2M

#### `AUTH0_TC_PROXY_URL`

- **Type**: String (URL)
- **Required**: Yes
- **Description**: Topcoder Auth0 proxy URL
- **Example**: `https://topcoder-dev.auth0.com`
- **Notes**: Used for additional Auth0 operations

### Trolley Configuration

#### `TROLLEY_ACCESS_KEY`

- **Type**: String
- **Required**: Yes
- **Description**: Trolley API access key
- **Notes**:
  - Use sandbox keys for development
  - Production keys for prod environment
- **How to get**: Trolley Dashboard → Settings → API Keys

#### `TROLLEY_SECRET_KEY`

- **Type**: String
- **Required**: Yes
- **Description**: Trolley API secret key
- **Notes**: Keep this secret secure
- **How to get**: Trolley Dashboard → Settings → API Keys

#### `TROLLEY_WH_HMAC`

- **Type**: String
- **Required**: Yes
- **Description**: HMAC secret for Trolley webhook signature validation
- **Notes**:
  - Used to verify webhook authenticity
  - Different from API keys
- **How to get**: Trolley Dashboard → Settings → Webhooks → Webhook Secret

#### `TROLLEY_WIDGET_BASE_URL`

- **Type**: String (URL)
- **Required**: Yes
- **Description**: Base URL for Trolley recipient portal widget
- **Example**: `https://trolley.link/recipient`
- **Format**: `https://trolley.link/recipient` or sandbox equivalent
- **Notes**: Used to generate portal access URLs for users

### Topcoder Platform Configuration

#### `TOPCODER_API_BASE_URL`

- **Type**: String (URL)
- **Required**: Yes
- **Description**: Base URL for Topcoder platform APIs
- **Example**: `https://api.topcoder-dev.com/v5`
- **Format**: `https://api.{environment}/v5`
- **Notes**:
  - Dev: `https://api.topcoder-dev.com/v5`
  - Prod: `https://api.topcoder.com/v5`

#### `TOPCODER_WALLET_URL`

- **Type**: String (URL)
- **Required**: Yes
- **Description**: Topcoder wallet frontend URL
- **Example**: `https://wallet.topcoder.com`
- **Notes**: Used for CORS configuration
- **Default**: `https://wallet.topcoder.com`

#### `TC_EMAIL_FROM_EMAIL`

- **Type**: String (Email)
- **Required**: Yes
- **Description**: From email address for system emails
- **Example**: `noreply@topcoder.com`
- **Notes**: Must be a valid, verified email address

## Optional Variables

### Application Configuration

#### `API_BASE`

- **Type**: String
- **Required**: No
- **Description**: Base path for all API routes
- **Example**: `/v5/finance`
- **Default**: `/v5/finance`
- **Notes**: Prefix for all endpoints

#### `PORT`

- **Type**: Integer
- **Required**: No
- **Description**: Port number for the application server
- **Example**: `3000`
- **Default**: `3000`
- **Notes**: Must be available and not in use

### Trolley Payment Configuration

#### `TROLLEY_MINIMUM_PAYMENT_AMOUNT`

- **Type**: Integer
- **Required**: No
- **Description**: Minimum payment amount in USD cents
- **Example**: `100` (= $1.00)
- **Default**: `0`
- **Notes**: Enforces minimum withdrawal amount

#### `TROLLEY_PAYPAL_FEE_MAX_AMOUNT`

- **Type**: Number (Decimal)
- **Required**: No
- **Description**: Maximum PayPal fee amount in USD
- **Example**: `20.00`
- **Default**: `0`
- **Notes**: Cap on PayPal fees

#### `ACCEPT_CUSTOM_PAYMENTS_MEMO`

- **Type**: Boolean
- **Required**: No
- **Description**: Allow custom memo text in payment requests
- **Example**: `true`
- **Default**: `false`
- **Values**: `true` or `false`
- **Notes**: When false, uses default memo

### Challenge Payment Configuration

#### `DESIGN_SCREENER_FEE`

- **Type**: Number (Decimal)
- **Required**: No
- **Description**: Flat fee in USD paid to the screener of a Design track challenge
- **Example**: `100`
- **Default**: `100`
- **Notes**: Overrides the coefficient based reviewer payment amount for the
  Screening phase of Design track challenges only

### Email Configuration

#### `TC_EMAIL_NOTIFICATIONS_TOPIC`

- **Type**: String
- **Required**: No
- **Description**: Kafka topic for email notifications
- **Example**: `external.action.email`
- **Default**: `external.action.email`
- **Notes**: Used for Topcoder bus messaging

#### `TC_EMAIL_FROM_NAME`

- **Type**: String
- **Required**: No
- **Description**: Display name for system emails
- **Example**: `Topcoder`
- **Default**: `Topcoder`

#### `SENDGRID_TEMPLATE_ID_PAYMENT_SETUP_NOTIFICATION`

- **Type**: String
- **Required**: No
- **Description**: SendGrid template ID for payment setup emails
- **Example**: `d-919e01f1314e44439bc90971b55f7db7`
- **Default**: `d-919e01f1314e44439bc90971b55f7db7`
- **Notes**: Must match template in SendGrid

#### `SENDGRID_TEMPLATE_ID_OTP_CODE`

- **Type**: String
- **Required**: No
- **Description**: SendGrid template ID for OTP code emails
- **Example**: `d-2d0ab9f6c9cc4efba50080668a9c35c1`
- **Default**: `d-2d0ab9f6c9cc4efba50080668a9c35c1`
- **Notes**: Must match template in SendGrid

### Security Configuration

#### `OTP_CODE_VALIDITY_MINUTES`

- **Type**: Number
- **Required**: No
- **Description**: OTP code validity duration in minutes
- **Example**: `5`
- **Default**: `5`
- **Range**: Recommended 1-10 minutes
- **Notes**: Balance security and user convenience

## Setup Guide

### 1. Initial Setup

1. **Copy the sample environment file**:

   ```bash
   cp .env.sample .env
   ```

2. **Edit the `.env` file** with your configuration:

   ```bash
   nano .env
   # or
   vim .env
   ```
