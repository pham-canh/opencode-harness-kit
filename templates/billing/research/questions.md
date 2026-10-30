# Research questions

1. Which write paths can be retried by a client or a provider?
2. What is the idempotency key for a payment: invoice id, attempt id, or a
   caller-supplied key?
3. How long does the provider keep a webhook, and can it arrive twice?
4. Which state transitions are illegal, and what does the API return?
5. How is a refund approved, and who can do it?
6. What is the billing period boundary, and which time zone does it use?
7. What happens to a pending payment when the provider times out?
8. Which audit questions has finance actually asked in the last year?
