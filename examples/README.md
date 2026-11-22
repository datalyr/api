# Examples

Runnable examples for the DATALYR Node SDK. Each one reads your API key from `DATALYR_API_KEY`.

| File | Shows |
| --- | --- |
| [basic.js](basic.js) | Track, identify, record a purchase and close the client |
| [express.js](express.js) | Track requests and signups in an Express app; close on shutdown |
| [stripe-webhook.js](stripe-webhook.js) | Record Stripe payments with `eventId` and `timestamp`, so redeliveries count once |

Install the SDK and the example's own dependencies first:

```bash
npm install @datalyr/api express stripe
```

Then run an example:

```bash
DATALYR_API_KEY=dk_your_api_key node examples/basic.js
```

See the [Node SDK reference](https://docs.datalyr.com/sdk-reference/node) for every method and option.
