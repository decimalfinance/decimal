# Provenance: Stablecoin Dashboard, Auth, and UX Research

Date: March 29, 2026

## Research question

How do real stablecoin infrastructure and treasury platforms structure login, organizations, roles, approvals, and dashboard UX, and what should that imply for our product?

## Primary sources used

### Stablecoin / crypto infrastructure

1. Bridge Developer Dashboard
   - https://bridge-docs.readme.io/docs/developer-dashboard
   - Used for: dashboard scope, team members, API keys, KYB before dashboard access

2. Bridge Authentication
   - https://apidocs.bridge.xyz/api-reference/introduction/introduction
   - Used for: API-key model, sandbox scoping

3. Paxos Dashboard
   - https://docs.paxos.com/guides/dashboard
   - Used for: dashboard scope and multi-entity positioning

4. Paxos Create Business Account
   - https://docs.paxos.com/guides/dashboard/account
   - Used for: org-first signup and entity onboarding flow

5. Paxos Complete Onboarding
   - https://docs.sandbox.paxos.com/dashboard/onboard
   - Used for: business onboarding / KYB flow

6. Paxos Sign In / Passkeys / Team Access / Roles / Approvals
   - https://docs.paxos.com/guides/dashboard/signin
   - https://docs.paxos.com/guides/dashboard/passkeys
   - https://docs.paxos.com/guides/dashboard/admin/team
   - https://docs.paxos.com/guides/dashboard/roles
   - https://docs.paxos.com/guides/dashboard/admin/approvals
   - Used for: passkey/SSO auth, entity manager invites, roles, approval workflows

7. Paxos SSO support note
   - https://support.paxos.com/hc/en-us/articles/35127251691668-How-do-I-set-up-SSO-for-my-account
   - Used for: staged auth maturity from passkeys to SSO

8. Circle API Keys
   - https://developers.circle.com/circle-mint/api-keys
   - Used for: admin-only key management and restricted keys

9. Circle API Logs
   - https://developers.circle.com/circle-mint/api-logs
   - Used for: developer logs in dashboard

10. Circle Manage Team Members
   - https://developers.circle.com/w3s/manage-team-members
   - Used for: team roles and view-only/admin split

11. Fireblocks Capabilities
   - https://developers.fireblocks.com/docs/capabilities
   - Used for: workspace concept, RBAC, admin quorum, policy model

12. Fireblocks Define Approval Quorums
   - https://developers.fireblocks.com/docs/define-approval-quorums
   - Used for: approval groups and sensitive configuration changes

13. Fireblocks audit log endpoint
   - https://developers.fireblocks.com/reference/getaudits
   - Used for: audit log access model

14. Coinbase Prime account structure
   - https://docs.cdp.coinbase.com/prime/concepts/account-structure
   - Used for: organization/entity/portfolio hierarchy

15. Coinbase Prime roles and permissions
   - https://help.coinbase.com/en/prime/roles-and-permissions/roles-and-permissions
   - Used for: entity/portfolio-level user roles and approvals model

### Adjacent payments / treasury platforms

16. Modern Treasury Dashboard Overview
   - https://docs.moderntreasury.com/platform/docs/dashboard-overview
   - Used for: dashboard scope and why admin/dev tools coexist with ops

17. Modern Treasury Roles and Permissions
   - https://docs.moderntreasury.com/platform/docs/roles-and-permissions
   - Used for: RBAC structure

18. Modern Treasury SSO
   - https://docs.moderntreasury.com/platform/docs/single-sign-on-sso
   - Used for: enterprise auth patterns

19. Modern Treasury SCIM
   - https://docs.moderntreasury.com/platform/docs/user-lifecycle-management-with-scim
   - Used for: directory-synced user lifecycle

20. Modern Treasury View Request Logs
   - https://docs.moderntreasury.com/platform/docs/view-request-logs
   - Used for: developer tooling placement

21. Modern Treasury Audit Trail / Audit Logs / SIEM
   - https://docs.moderntreasury.com/platform/docs/audit-trail
   - https://www.moderntreasury.com/journal/audit-logs
   - https://docs.moderntreasury.com/platform/docs/siem
   - Used for: auditability, security operations, and event export patterns

## Key factual patterns extracted

- Access is organization- or entity-scoped.
- Sensitive actions require approvals or quorums.
- Roles are explicit and often split into operator / approver / developer / viewer / manager classes.
- Dashboard home is for operations and administration, not for dumping all setup forms at once.
- Developer tools exist, but usually live in separate settings/developer sections.
- Auth matures from invite-based accounts to SSO / SCIM / passkeys / MFA.

## Inferences made from the sources

These are reasoned conclusions, not direct quotes:

1. Our product should add login now because the product is already multi-tenant by data model.
2. Our first product page should be login or workspace setup, not a giant workspace screen.
3. We should split the app into setup vs monitor rather than styling one overloaded screen.
4. A compact nav and explicit route structure will fit this category better than a bulky sidebar with explanatory text.

## Limitations

- Some Paxos pages returned `403` on full-page open, so I relied on high-quality indexed snippets where necessary.
- This research focuses on auth, roles, approvals, and dashboard structure, not pricing or market sizing.
- I did not inspect private product screenshots; conclusions are based on public docs and help centers.
