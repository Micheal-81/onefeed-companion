# OneFeed Companion — Privacy Policy

Last updated: 2026-09-19

## What the extension does

OneFeed Companion imports a user's own social-media follow lists into
onefeed.online, using the user's own logged-in browser session, and relays feed
requests through that browser. It acts only when the user explicitly starts an
import or the onefeed.online page requests a feed fetch.

## What data is handled

- **Authentication information.** The extension reads session cookies for the
  specific platform the user chooses to import from (e.g., a session token).
  Cookies are used only to authenticate requests sent directly to the platform
  that issued them. They are never transmitted to OneFeed's servers or to any
  third party.
- **Website content.** During a user-initiated import, the extension reads the
  list of followed handles from the platform page it opens. Only handle names
  are returned to the onefeed.online page the user is on. No other page
  content, messages, or personal data is collected.

## What is transmitted and where

- Follow-list handle names are delivered to the onefeed.online page the user is
  actively using, where the user chooses whether to save them to their OneFeed
  account.
- Feed fetches are relayed between onefeed.online and the platform being
  fetched, over HTTPS.
- No data is sent to analytics, advertising, or any third-party service. The
  extension has no telemetry.

## What is stored

- `chrome.storage.session` holds temporary bookkeeping (which import tab is
  open) for the duration of an import. It contains no personal data and is
  cleared when the browser session ends.

## Sharing and selling

No user data is sold, shared, or transferred to third parties. No data is used
for advertising, creditworthiness, lending, or any purpose unrelated to the
extension's single purpose.

## Security

All network traffic uses HTTPS. Credentials and cookies remain in the user's
browser and are used only on the platform that issued them.

## Contact

Source code: https://github.com/Micheal-81/onefeed-companion
Contact: dev@onefeed.online
