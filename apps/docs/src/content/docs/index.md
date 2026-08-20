---
title: Delfrance
description: Open-source ERP — Next.js rewrite of the Delfrance Flutter app.
template: splash
hero:
  tagline: ERP for business process automation. Multi-tenant, plugin-based, Firebase-backed.
  actions:
    - text: Get started
      link: /getting-started/overview/
      icon: right-arrow
      variant: primary
    - text: Architecture
      link: /architecture/
      variant: minimal
---

This site documents the **Next.js rewrite** of the Delfrance ERP. The original Flutter app still runs in production, on its own Firebase project; this rewrite runs on staging and **replaces** it at a single cutover — the two never run against the same data. See [ADR 0013](/adr/0013-firebase-project-migration/) and [Legacy data compatibility](/guides/coexistence/).
