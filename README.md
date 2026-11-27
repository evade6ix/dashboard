# Go Next Operations

A private, light-mode Shopify fulfillment workspace for Go Next Hobbies. React + Vite on the frontend, Express + Socket.IO on the server, and PostgreSQL on Railway.

## Included

- Searchable order queue with awaiting, all, fulfilled, and hold/preorder views.
- Same-page right-hand order details, shipping address, notes, line items and shipment history.
- Full or partial fulfillment using Shopify fulfillment-order line IDs, carrier, tracking number, optional tracking URL and customer notification.
- Daily operational order value in Shopify's shop currency and store timezone. Includes shipping/tax; uses current totals, excludes cancelled orders. This is **not** Shopify's accounting sales report or payment settlement total.
- Retail and cost inventory values for **active products only**. Uses available stock, clamps negative stock to zero, identifies missing unit costs. Draft/archived products are excluded.
- PostgreSQL cache, durable signed-webhook inbox with retries, database notifications and authenticated WebSockets. No browser refresh needed. Reconnect refreshes the cache immediately. A full reconciliation runs every 15 minutes.
- Private password login with signed HttpOnly session cookies, origin checks and login rate limiting. Credentials stay server-side.
- An explicit demo mode with sample data; demo fulfillment never calls Shopify.

## Local development

Requires Node 22 or newer (Docker uses Node 24).

```sh
npm ci
cp .env.example .env
npm run dev
```

Open Vite's local URL. The frontend proxies `/api` and `/socket.io` to port 3000. Demo works without a database. Use a disposable database and development Shopify store for integration testing.

```sh
npm test
npm run build
npm start
```

## Railway setup

1. Create a Railway project with **PostgreSQL** and an app service sourced from this repository.
2. Configure the app's variables below. Railway detects the Dockerfile; `railway.json` sets `/health` and restart policy. Use **one application replica** initially. PostgreSQL notifications support multiple connected processes, but a singleton synchronization worker is the intended starting topology.
3. Generate a public HTTPS domain and set `APP_URL` to that origin, without a path.
4. Deploy, sign in, and open **Settings → Register Shopify webhooks**. Inspect the result for any missing scope errors. Registration is explicit and skips existing matching subscriptions.
5. Trigger **Sync with Shopify** if needed. The first sync loads all orders Shopify makes available and active inventory. Watch server logs for Shopify permission errors.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` (already set by Docker) |
| `DEMO_MODE` | `false` for live operations; `true` only for a sample workspace |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` using your database service's actual name |
| `SHOPIFY_STORE` | Your canonical `xxxxx.myshopify.com` domain; confirm in Shopify **Settings → Domains**. The admin store handle may differ. |
| `SHOPIFY_CLIENT_ID` | Existing app Client ID (included in `.env.example`) |
| `SHOPIFY_CLIENT_SECRET` | App secret, entered only in Railway variables |
| `SHOPIFY_API_VERSION` | `2026-10` |
| `APP_URL` | Public HTTPS origin of this app |
| `DASHBOARD_PASSWORD` | Long unique workspace password |
| `SESSION_SECRET` | Random secret of at least 32 characters |
| `SHOPIFY_ACCESS_TOKEN` | Optional alternative Admin access token; otherwise app exchanges client credentials automatically |

The app and store must belong to the same Shopify organization to use the client credentials grant, and the app must be installed. Tokens are refreshed server-side before expiry. The Client ID alone is insufficient. Even with an explicit access token, `SHOPIFY_CLIENT_SECRET` is required to verify webhook signatures.

For a public Railway demo, explicitly set `DEMO_MODE=true`. To restrict the demo, also set `DASHBOARD_PASSWORD` and `SESSION_SECRET`. Otherwise sample data is intentionally public. Live mode refuses to start without required database and authentication configuration.

### Shopify access

Required capabilities include reading orders, products and inventory and writing merchant-managed fulfillment orders. Depending on your locations, assigned/third-party fulfillment-order scopes may also be needed. Older order history requires Shopify's `read_all_orders` approval in addition to `read_orders`; otherwise Shopify usually limits order history to 60 days. Customer names, emails and addresses may require protected customer data access. Having scopes configured in the dashboard does not replace installing/re-authorizing the app on the store.

The integration registers order create/update/delete, product create/update/delete, inventory level update and inventory item update webhooks. Shipping fulfillment actions update orders, so order updates refresh shipment history too. Webhooks are verified against the exact raw request body and store domain before being saved. A durable database job is acknowledged only after insertion, then processed asynchronously. Catalog-related events trigger a complete, paginated active-catalog refresh; periodic reconciliation covers missed events. This implementation is optimized for a small retailer, not a bulk Shopify-scale warehouse.

### Fulfillment safety and recovery

The application fetches current fulfillment orders before each shipment and validates remaining quantities, supported actions and locations. Selected items from multiple locations must be shipped separately in Shopify. Fulfillment orders with over 100 fulfillment lines are deliberately blocked and can be handled in Shopify; regular order lines and product variants are fully paginated.

Each fulfillment submission has a request ID persisted **before** calling Shopify. Successful retries return the saved result. A network failure after the call may have an uncertain outcome, so pending attempts block further shipments for that order rather than risking duplicate tracking emails or fulfillment. If this occurs:

1. Check the order's fulfillment history in Shopify directly. Confirm whether the exact tracking number/items were fulfilled.
2. Have an operator inspect the `fulfillment_attempts` row using its `order_id` and `key`.
3. After verifying Shopify, mark that attempt `success` if fulfilled or `rejected` if definitively not processed. Never reset an uncertain request blindly. Trigger order sync afterward.

The confirmation step in the UI states item count, carrier, tracking and notification choice. Hold/preorder tags and order notes are shown as a warning; they do not enforce third-party Addora hold rules. Verify release readiness before confirming. Cancellation, purchasing labels and carrier label generation are outside this first version.

### Performance and deployment notes

The UI reads cached data rather than waiting for Shopify on every navigation. The initial order snapshot currently includes the full cached order list; introduce indexed server pagination and dedicated SQL aggregates if order volume becomes very large. Inventory endpoints likewise serve cached active products. Socket events invalidate browser snapshots and clients fetch the fresh state. Initial import and reconciliation respect Shopify GraphQL throttling with bounded retry backoff.

Postgres is the durable source for the cache and webhook jobs. Back up the Railway database. Session secret rotation invalidates existing sessions. The login is a shared private-team password; individual user accounts and role permissions are not included.

## Validation

`npm test` checks timezone boundaries, inventory eligibility and costing, webhook signatures, and partial-fulfillment validation including multi-location and invalid-quantity rejection. `npm run build` creates the production client. Live Shopify and Railway integration require environment credentials; demo checks cannot prove live permissions, carrier recognition, webhook delivery or account-specific behavior.

## Shopify references

- [Client credentials authentication](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant)
- [Fulfillment creation](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentCreate)
- [Webhook subscription creation](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/webhookSubscriptionCreate)
