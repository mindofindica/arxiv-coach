# arXiv rate limiting / politeness

arXiv does not publish a single hard request/second quota for the legacy API endpoint (`export.arxiv.org/api/query`). In practice, clients can receive HTTP **429** (Too Many Requests) if they query too frequently.

## Our defaults (V0)

We aim to be a good citizen and avoid hammering arXiv.

- **Max results per category fetch:** 100
- **Minimum spacing between API calls:** **≥ 3 seconds**
- **Backoff on errors:** retry on 429 and 5xx with exponential backoff + jitter

## Sources / notes

- arXiv API Terms of Use emphasizes respecting rate limits and that access may be blocked if usage threatens availability.
  - https://info.arxiv.org/help/api/tou.html
- arXiv API community discussions commonly reference waiting **> 3 seconds** between queries as a good-citizen guideline.
  - https://groups.google.com/g/arxiv-api/c/ot68bhhE4-4

## Implementation notes

- We enforce a minimum delay between API calls at the runner level (category fetch loop).
- In addition, we add exponential backoff on retryable failures.
- During development, avoid repeatedly running discovery loops; prefer running `npm run artifacts` to process already-matched papers without touching the API.
