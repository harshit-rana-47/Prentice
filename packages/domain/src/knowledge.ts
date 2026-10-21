/** Maintained paraphrases of primary documentation; general principles, not repository observations. */
export const KNOWLEDGE_REVISION = "2026-10-16.1";
export const KNOWLEDGE = [
  {
    id: "outbox", source: "https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html",
    principle: "A sender commits its business data change and an intent-to-send record in ONE LOCAL database transaction BEFORE a separate relay sends the message. Sending can repeat, e.g. after delivery succeeded but its acknowledgement was lost. Outbox durability alone does not suppress duplicate receiver effects. A receiver must durably coordinate deduplication with its own effect; a sender's local record cannot atomically encompass an uncoordinated external API. If a receiver already atomically recorded a stable key with its effect, a sender crash does not erase that receiver record. Do not claim exactly-once external effects without stating the required receiver/protocol assumptions.",
  },
  {
    id: "cookies", source: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie",
    principle: "HttpOnly restricts script access to a cookie, not automatic cookie sending or all XSS actions. Secure restricts transmission to secure transport (with browser localhost exceptions); it does not make a cookie unreadable to scripts. SameSite=Strict permits same-site requests (not only navigations) and excludes cross-site requests, including top-level GET navigations. SameSite=Lax additionally permits cross-site top-level navigations using safe methods such as GET; it does not generally permit cross-site subresource requests or unsafe POSTs. Cross-site is not the same as cross-origin. Keep the selected mode fixed throughout an example, or explicitly label a change of mode; a cross-site GET example that works under Lax does not work under Strict. A session cookie is sent on matching requests; the server must validate the session. localStorage is readable by same-origin scripts and is not automatically attached as a Cookie header. Do not infer a storage method or implemented flags from a filename, an API's presence, or a learner's guess.",
  },
  {
    id: "csrf", source: "https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html",
    principle: "CSRF exploits ambient credentials on unwanted requests. HttpOnly alone does not prevent it. SameSite is defense in depth with mode-dependent limits, not a universal replacement for server-side CSRF defenses. XSS can undermine CSRF defenses. POST-only endpoints alone do not establish request intent or prevent CSRF. A defense must verify a valid token, trusted request origin or another established protection appropriate to the threat model. Do not claim client validation or CORS alone authorizes requests.",
  },
  {
    id: "transactions", source: "https://www.postgresql.org/docs/current/tutorial-transactions.html",
    principle: "A database transaction commits its participating changes together or rolls them back. It does not undo arbitrary emails, HTTP calls or other external effects. Atomicity is not serializable isolation; concurrent correctness depends on isolation/locking/constraints. A failed transaction cannot be assumed to have partially committed its participating writes. External operations are outside this guarantee unless an explicit coordination mechanism is established.",
  },
  {
    id: "authorization", source: "https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html",
    principle: "Authentication identifies a caller; authorization decides permitted actions/resources. Hiding client controls is not server authorization. Requests can bypass a browser UI; validate permissions on each protected request. Do not assert a repository does this without recorded evidence supporting the actual behavior.",
  },
  {
    id: "interruption", source: "https://nodejs.org/api/child_process.html#subprocesskillsignal",
    principle: "Sending a termination signal is a request, not proof the process exited. Killing a parent need not kill all descendants. Abort/cancellation is cooperative and cannot undo already committed writes or remote effects. Claims of process containment require the actual mechanism and platform limits, and recorded verification; an AbortController call or exit status alone cannot establish that every descendant stopped.",
  },

  {id:"indexes",source:"https://www.postgresql.org/docs/current/indexes-intro.html",principle:"An index can locate matching rows without scanning the whole table when suitable for the query. Maintaining indexes adds storage and write overhead. The query planner can choose a sequential scan when it estimates that to be cheaper. An index does not guarantee every query becomes faster."},
  {id:"isolation",source:"https://www.postgresql.org/docs/current/transaction-iso.html",principle:"Atomicity and isolation are different properties. In PostgreSQL Read Committed each statement sees a snapshot as of its start; successive statements can see different committed data. Serializable transactions can fail with serialization errors and require retrying the entire transaction. Check-then-write code needs appropriate locking, constraints or isolation to handle concurrent requests."},
  {id:"caching",source:"https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching",principle:"An HTTP cache can reuse stored responses under their freshness and request matching rules. Cache-Control no-cache permits storage but requires validation before reuse; no-store instructs caches not to store the response. ETag with If-None-Match allows a server to validate a representation and return 304 if unchanged. Vary changes which request headers participate in response selection. A cached response can be stale; caching does not guarantee current origin state."},
  {id:"types",source:"https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions",principle:"TypeScript checks types before runtime and erases type annotations when emitting JavaScript. A type assertion does not validate or transform an incoming value at runtime. Untrusted JSON needs runtime validation before relying on its shape. Static types alone cannot stop malformed network input."},
  {id:"promises",source:"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all",principle:"Promise.all fulfills with results in input order once all inputs fulfill, and rejects when an input rejects. Rejection does not automatically cancel already-started operations or undo their effects. Independent asynchronous operations can overlap, but Promise.all does not guarantee CPU parallelism. An empty input fulfills with an empty array."},
  {id:"sql-injection",source:"https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html",principle:"Parameterized queries separate SQL structure from bound data values, preventing those values from becoming SQL syntax. Concatenating untrusted input into SQL structure defeats that separation. Bind parameters generally cannot stand for table names, column names or sort directions; use a fixed mapping or allow-list for such choices. Input validation and least privilege complement parameterization."},
  {id:"backoff",source:"https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",principle:"Timeouts bound how long a caller waits, not whether a remote side effect occurred. Retrying side-effecting operations needs idempotency or reconciliation. Bounded backoff reduces retry load and jitter spreads synchronized retry bursts. Retries at multiple layers can amplify load; backoff does not guarantee eventual success or exactly-once effects."},
] as const;
const terms: Record<string,RegExp> = {
 outbox:/outbox|idempoten|dedup|exactly.once|receiver|acknowledg/,cookies:/cookie|httponly|samesite|localstorage|session/,
 csrf:/csrf|cross.site|samesite|cors|xss/,transactions:/transact|rollback|atomic|commit|outbox/,
 authorization:/authoriz|authenticat|permission|(?:resource|user|account|tenant).{0,24}ownership|ownership.{0,24}(?:access|permission)|protected|client.*server/,interruption:/abort|cancel|interrupt|descendant|child.process|signal/,
 indexes:/index|query plan|sequential scan/,isolation:/isolat|serializ|concurren|race|check.then/,
 caching:/cach|etag|no.store|no.cache|304|vary/,types:/typescript|type assertion|runtime valid|untrusted json/,
 promises:/promise|async|asynchronous|parallel/,"sql-injection":/sql injection|parameteriz|bound param|prepared quer/,
 backoff:/backoff|jitter|retr(?:y|ies)|timeout/,
};
/** Retrieval sends no request to a third-party search engine. A match is a candidate
 * reference, never sufficient evidence that the entire question is covered. */
export function knowledgeFor(value:unknown){
 const text=JSON.stringify(value).toLowerCase();
 return KNOWLEDGE.filter(r=>terms[r.id].test(text)).slice(0,6);
}
