# SMM Panel Telegram Bot

## Providers
`shweboost`, `secsers`, `hiroshi`, `morethanpanel` (list lives in `provider-ids.js`).

| Provider | .env keys |
|---|---|
| ShweBoost | `SHWEBOOST_API_URL`, `SHWEBOOST_API_KEY` |
| Secsers | `SECSERS_API_URL`, `SECSERS_API_KEY` |
| Hiroshi | `HIROSHI_API_URL`, `HIROSHI_API_KEY` |
| MoreThanPanel | `MORETHANPANEL_API_KEY` (URL defaults to `https://morethanpanel.com/api/v2`) |

Optional per provider: `<NAME>_USD_TO_MMK`, `<NAME>_MARKUP_MULTIPLIER` (or `/setrate morethanpanel 4400 2.3`).

Customers never see provider names. If a provider fails (e.g. "Not enough funds on balance"),
the customer gets the editable text `order_error_contact_admin`, their money is refunded,
and the admins get a Telegram alert naming the provider and reason.
