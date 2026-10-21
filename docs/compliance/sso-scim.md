# Enterprise SSO and SCIM for an Effigent workspace

**Status (2026-10-21): available through Clerk, not yet set up for any customer.** Nothing in
this document has been run end to end against a customer IdP. Clerk facts were read from Clerk's
docs, changelog and pricing page on **2026-10-21**. Re-check prices before quoting them to a
customer.

Covers vendor checklist item 19.

## 1. How console sign-in works today (from the code)

- **Sign-in:** the console (`packages/dashboard`, app.effigent.ai) signs people in with Clerk.
  Every API call carries the Clerk session JWT. The control plane checks it against the Clerk
  instance's JWKS (`CLERK_ISSUER`) and, when `CLERK_AUTHORIZED_PARTIES` is set, also checks the
  `azp` origin (`internal/controlplane/server/auth.go`).
- **Workspace = Clerk organisation:**
  - The active organisation in the token becomes the tenant `org:<id>`.
  - The role comes from the token. Session-token v2 uses `o.rol`, which has no prefix. The
    older v1 claim `org_role` (`org:admin`) is still accepted, and the code strips its `org:`
    prefix.
- **What each role can do** (`Principal.CanWrite`):

  | Clerk organisation role | Effigent role | Can do |
  |---|---|---|
  | `org:admin` | `admin` | Change policy, machines, tokens, settings. Step in on any approval. |
  | `org:security_admin` (custom role) | `security_admin` | The same as admin. |
  | `org:member`, or any other role | e.g. `member` | Read-only. Can decide approvals routed to an approver group they are listed in. |

  "Viewer" is not a separate role: every role other than admin and security_admin is read-only.
- **No organisation in the token** means a personal workspace `user:<id>`, and its owner is
  `admin`. The console's organisation switcher shows personal workspaces
  (`hidePersonal={false}` in `components/ClerkUserMenu.tsx`).
- **Members and invitations** are managed in Clerk's `<OrganizationProfile>`, which the console
  opens from Team & Approvers.
- **Approver groups** (`cp.approval_routing`) store members by Clerk user id and email, picked
  from the organisation's memberships.
- **Clerk's Backend API** (`CLERK_SECRET_KEY`, `server/directory.go`) is used only to:
  - look up a person's verified emails, for Slack approvals and the requester-vs-approver rule;
  - map a Slack approver's email to a console role.
- **Effigent receives nothing from SCIM directly.** It has no webhook for Clerk's user or
  membership events. The only Clerk webhook route in the console is the old product's
  `organization.created` handler (see §6).

## 2. What Clerk offers, and what it needs

Read 2026-10-21.

| Capability | What it does | Clerk plan / add-on (production) | Source |
|---|---|---|---|
| Enterprise SSO (SAML: Okta Workforce, Microsoft Entra ID, Google Workspace, custom SAML; OIDC; EASIE) | Users on the connection's email domain are sent to the IdP at sign-up and sign-in | Pro ($25/mo, $20 annual) or Business ($300/mo, $250 annual). Each includes 1 SSO connection per app; connections 2–15 are $75/mo each, 16–100 are $60/mo each, 101+ "Contact us" | [overview](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview), [pricing](https://clerk.com/pricing) |
| Link a connection to an organisation | SSO users are added to that organisation with the default role (JIT) | Pro/Business **plus the B2B Authentication add-on, "Enhanced" tier: $100/mo ($85 annual)**. That tier lists "Link Enterprise connections with Organizations" | [org SSO](https://clerk.com/docs/guides/organizations/add-members/sso), [pricing](https://clerk.com/pricing), [self-serve SSO](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/self-serve-sso) ("The plan provides production enterprise connections, while the add-on enables linking those connections with Organizations.") |
| Custom roles (needed for `security_admin`) | Organisation roles beyond admin/member | B2B Authentication add-on in production; free in development | [roles and permissions](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions) |
| Directory Sync (SCIM 2.0: Okta, Entra ID, any SCIM 2.0 IdP; Google Workspace via the Admin SDK) | Provisions users and deprovisions them: deactivates the user and revokes all sessions | Pro or Business. 1 Directory Sync connection included, then $75 / $60 / "Contact us", "Counted separately from SSO connections". The docs say billing for these connections starts 2027-01-01. Needs an existing SAML or OIDC connection. GA 2026-04-16 | [directory sync](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/directory-sync), [GA changelog](https://clerk.com/changelog/2026-04-16-directory-sync), [Google Workspace](https://clerk.com/changelog/2026-08-05-google-workspace-directory-sync) |
| Groups → roles | IdP group → organisation role; the mapping highest in the list wins | Needs a connection linked to an organisation, so in practice the add-on as well (our inference; the Directory Sync doc names only Pro/Business). GA 2026-05-21 | [directory sync, "Role mapping"](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/directory-sync), [GA changelog](https://clerk.com/changelog/2026-05-21-directory-sync-groups-attributes-ga) |
| Self-serve SSO / Directory Sync | The customer's own admin sets up the connection from the organisation profile's **Security** tab | Pro/Business + add-on. SAML 2026-06-26, OIDC 2026-07-31, Directory Sync 2026-09-30 | [self-serve SSO](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/self-serve-sso), [changelog](https://clerk.com/changelog/2026-06-26-self-serve-sso), [self-serve directory sync](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/self-serve-directory-sync) |
| SSO enforcement | Once a connection is active, "Password, email link, and passkey sign-ins are still blocked for users on a domain served by an enterprise connection". An opt-in bypass allowlist (email code) exists | Same as SSO | [SSO bypass](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/sso-bypass) |

Notes from the same pages:
- **Naming changed:** "Enhanced Authentication Add-on" was eliminated on 2026-02-05
  ([changelog](https://clerk.com/changelog/2026-02-05-new-plans-more-value)). The add-on that
  links SSO to organisations is now called **B2B Authentication (Enhanced)**.
- **Custom role limit:** the roles doc says "up to 10 custom Organization Roles per application
  instance", but the pricing page says "unlimited". We need one custom role, so either is enough.
- **Price conflict:** the 2026-04-16 changelog called Directory Sync "included … at no extra
  charge". The current docs and pricing page charge per connection from 2027-01-01. We go by
  the newer pages.
- **Business plan** adds Clerk features for our own dashboard team: SSO for the Clerk Dashboard,
  enhanced dashboard roles, more seats. It isn't needed for customer SSO. It is relevant to our
  own SOC 2 access controls (see `soc2-plan.md`).

## 3. What Effigent must enable on its Clerk production instance (one-time)

1. **Plan:** Pro is the minimum; Business if we want SSO for our own Clerk Dashboard. Add the
   **B2B Authentication add-on (Enhanced)**.
2. **Create the custom role `org:security_admin`** in Roles & Permissions, in the role set our
   organisations use. The code expects exactly this key: `auth.go` compares the role to
   `security_admin` after stripping `org:`.
   - **Open:** we have not checked whether it already exists in production.
3. **Default role for new members:** keep it `org:member`, so SSO JIT users land read-only.
   Admins are then promoted by hand or by group mapping.
4. **Session token v2:** confirm the instance issues v2 tokens. The code accepts both v1 and v2.
5. **Self-serve SSO (optional):** turn it on per customer organisation. In the Dashboard:
   Organizations → organisation → Settings → Organization permissions → "Allow this organization
   to set up enterprise SSO and Directory Sync".
6. **Budget:** each customer's SSO connection after the first included one is $75/mo, and each
   Directory Sync connection after the first is $75/mo once billing starts.

## 4. Steps for a customer admin

There are two routes. Either way, the customer's IdP admin and an Effigent workspace admin both
take part.

### A. Effigent configures it (Clerk Dashboard; the customer supplies IdP metadata)

1. The customer gives us their **email domain(s)** and the **name of their Effigent
   organisation**.
2. We go to Clerk Dashboard → **SSO connections** → **Add connection** → **For specific domains
   or organizations**, then pick the provider (Okta Workforce, Microsoft Entra ID, Google
   Workspace, custom SAML or OIDC). We enter the domain, **select the customer's organisation**
   and name the connection.
3. **SAML:** we send the customer the ACS URL and entity ID Clerk shows. They create the app in
   their IdP and send back the IdP metadata URL or XML. **OIDC:** they send discovery URL, client
   ID and secret. Provider guides:
   [Okta](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/saml/okta),
   [Entra ID](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/saml/azure),
   [OIDC](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/oidc/custom-provider).
4. **Test before enabling.** Clerk's guides warn that a misconfigured connection, once enabled,
   locks out existing users on that domain.
5. **Enable the connection.** Everyone on the domain is now sent to the IdP. Password, email-link
   and passkey sign-in are blocked for that domain.
6. **Existing members:** Clerk links an existing account with the same verified email
   automatically ([account linking](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/account-linking)).
7. **New users:** they arrive via JIT with the default role (`org:member`, read-only in Effigent).
   To keep sign-in to people the IdP has assigned and Clerk already knows, turn off **Create
   users during sign-in**
   ([JIT](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/jit-provisioning)).

### B. Self-serve (once we enable it for the organisation)

The customer's Effigent admin opens the organisation profile → **Security**. There they verify
the domain by DNS TXT, pick the provider, paste the IdP details, test, and activate. Directory
Sync is in the same tab (a three-step wizard; the bearer token is shown once). Role mapping and
custom attributes stay with us (Clerk Dashboard) and start switched off for a self-serve
directory.

### Directory Sync (SCIM) deprovisioning

1. **Get the endpoint and token.** Clerk Dashboard → SSO connections → the connection →
   **Directory sync** → **Set up directory sync** gives a SCIM endpoint URL and a bearer token.
   (Self-serve: the Security tab.)
2. **Okta:** Provisioning → Configure API Integration.
   - Put the URL in "SCIM connector base URL" and the token in "API Token".
   - Set the unique identifier to `userName`.
   - Under **To App**, enable Create Users, Update User Attributes and Deactivate Users.
   - Map `email`.
   - Turn on **Push Groups** if roles will be mapped.
3. **Entra ID:** Provisioning → Automatic.
   - Put the URL in Tenant URL and the token in Secret Token, then Test Connection.
   - Map `userName`, `name.givenName`, `name.familyName`, `email`, `active`.
   - Set Provisioning Status to On.
4. **Every user needs an email** in the SCIM `emails` attribute.
5. **What happens when a user is removed or deactivated in the IdP** (Clerk docs):
   - Clerk deactivates the Clerk user and revokes all of their sessions at once. A SCIM `DELETE`
     is treated the same way: the user is deactivated, not deleted.
   - The organisation membership is removed only when no remaining directory grant gives it.
   - Memberships created outside Directory Sync are left alone.
6. **What that means in Effigent:** the person can no longer get a session token, so console
   and API access ends. Clerk session tokens are short-lived (about 60 s by default; we haven't
   confirmed this for our instance). Effigent does **not** clean up its own data (see §5).

### Groups → roles

Clerk Dashboard → the connection → Directory sync → **Role mapping** → **Map role**. Map, for
example:
- `effigent-admins` → `org:admin`
- `security-team` → `org:security_admin`
- everyone else → the default `org:member`

Rules:
- The mapping highest in the list wins.
- Only direct group membership counts; nested groups don't.
- A mapped role can't be changed by hand in the Dashboard.
- When someone leaves all mapped groups, they fall back to the default role.
- We found no documented way to map a **SAML** group attribute straight to a role. Role mapping
  is a Directory Sync (SCIM groups / Google Workspace groups) feature.

Effigent needs no change for any of this. It reads the role from each session token, so a role
change applies on the next token refresh.

## 5. Gaps and open questions (honest list)

1. **Approver groups don't follow deprovisioning.**
   - Group members are stored in Effigent (`cp.approval_routing`) by user id and email.
   - Email Approve/Deny links check membership in that stored group, not in Clerk
     (`server/actionlinks.go`, `memberOf`).
   - A deprovisioned person who is still listed keeps getting approval emails, and their links
     still decide as long as they can read that mailbox.
   - Fix (not built): handle Clerk's `user.updated` (`deprovisioned: true`) and
     `organizationMembership.deleted` webhooks, or check Clerk membership at decision time.
     Until then, remove leavers from approver groups by hand.
2. **API keys aren't tied to a person.** `efk_` keys are workspace keys. They keep working after
   the person who created them leaves. Revoke them in Settings → API keys as part of offboarding.
3. **Personal workspaces.** An SSO-enforced user can still pick their personal workspace in the
   organisation switcher, where they are admin.
   - It holds no customer data unless someone enrolls machines into it. Enrollment tokens are
     created per workspace.
   - Open: hide personal workspaces (`hidePersonal`), or turn personal accounts off in Clerk,
     once customers are on SSO.
4. **`security_admin` must exist in Clerk** (§3.2). Without the add-on, a customer can only use
   admin/member.
5. **Old console route checks only `org:admin`.** `packages/dashboard/src/app/api/v1/storage/route.ts`
   (the old run-storage feature) doesn't recognise `security_admin`. Harmless for v2 features but
   inconsistent.
6. **Roles aren't mirrored in the audit trail's subject list.** The audit trail records the role
   of each actor at the time. Effigent keeps no history of role changes; that history lives in
   the IdP and Clerk.
7. **Untested:** no SAML/OIDC connection, Directory Sync or role mapping has been tried against
   our production Clerk instance or a real Okta/Entra tenant. A pilot with one customer's IdP is
   the next step.
8. **Not verified:** our current Clerk plan and whether the B2B add-on is active. These are
   account facts, not visible in the code.
9. **Session-token lifetime and `azp` origin list in production.** We haven't confirmed that
   `CLERK_AUTHORIZED_PARTIES` is set to `https://app.effigent.ai` on App Runner.
