---
name: customer-dashboard
description: Build a shareable, user-friendly dashboard page for a Mercura config-panel customer - their configurators, quote figures, quick links and the Mercura documentation. Use when the user asks for a customer dashboard, a customer portal or overview page, a status page for a tenant, or a page that links to the documentation.
---

# Customer dashboard

1. Call `connection_status`; the user must be logged in to the customer's config-panel.
2. Call `build_customer_dashboard` (pass `companyName` when the user names the customer). It returns a complete HTML page: configurators with live/inactive state and edit links, quote totals and the latest quotes (ids, totals and dates only; no customer names or e-mails), links to config-panel and the storefront, and the documentation at docs.config.mercura.io grouped by topic.
3. Write the `html` to a file unchanged and publish it as a page; give the user the link. It is private until they share it.
4. The figures are a snapshot. To refresh, run the tool again and republish the same page.
