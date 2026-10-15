# Fixed egress IP for Shopee Open Platform on Firebase App Hosting + Cloud Functions gen2

**Date of prices:** 2026-09-03. All figures are USD list, no committed-use discounts.

---

## 0. Assumptions behind every number

| Assumption | Value | Why |
|---|---|---|
| Month length | **730 h** | Google's own monthly renderings use 730 (e.g. $0.005/h ↔ "$3.65 / 1 month" on [network pricing](https://cloud.google.com/vpc/network-pricing)). Google's *Cloud NAT examples* use 720 h — subtract ~1.4% if you prefer that convention. |
| Region | **us-central1 or us-east1** | Both are Cloud Run Tier 1 ([pricing tiers](https://cloud.google.com/run/pricing#tiers)) *and* Compute Engine free-tier-eligible ([free tier](https://docs.cloud.google.com/free/docs/free-cloud-features)). |
| Shopee traffic volume | **< 1 GiB/month** | JSON API calls + webhook acks. This puts egress inside free allowances in most options, so egress is not a differentiator. |
| Free-tier e2-micro | **unconsumed** | It is *per billing account*, not per project — see §4. |
| Boot disk | **pd-standard ≤ 30 GB** | Only "30 GB-months standard persistent disk" is free; pd-balanced/pd-ssd bill from the first GB ([free tier](https://docs.cloud.google.com/free/docs/free-cloud-features)). |
| Excluded from all rows | App Hosting / Cloud Run compute | Identical across options. Note it is *not* zero if you set `minInstances: 1` for the Shopee 3-second push ack: idle min-instance billing is $0.0000025 per vCPU-second **and** per GiB-second ([Cloud Run pricing](https://cloud.google.com/run/pricing)) → ~$9.86/month for 1 vCPU + 512 MiB before free tier, ~$6.57 at 0.5 vCPU. |

---

## 1. Cost table

| # | Option | Fixed $/mo | Variable | Realistic total $/mo |
|---|---|---|---|---|
| **A** | Direct VPC egress + Cloud NAT + static IP | **$3.65** (NAT IP) **+ $1.02 → $32.12** (gateway uptime) | $0.045/GiB NAT processing (in **and** out) + internet egress | **$4.67 – $35.77** |
| **B** | Serverless VPC connector + Cloud NAT | **$12.23** (2 × e2-micro) + **$2.04** (NAT gateway, 2 VMs) + **$3.65** (NAT IP) | same as A; connector ratchets to 10 instances → up to $61.15 | **$17.92** floor, **~$97** worst case |
| **C** | Free-tier e2-micro proxy, reached over the **public internet** with proxy auth | **$3.65** (external IP) | egress both hops; ≈$0 at this volume | **~$3.65** |
| **D** | Free-tier e2-micro proxy, reached by **internal IP** via Direct VPC egress (no NAT) | **$3.65** (external IP) | $0 same-zone internal; $0.01/GiB cross-zone; egress to Shopee | **~$3.65** |
| **E** | Register Google's published ranges (`cloud.json`) | $0 | — | **Does not work — see below** |

### Line-item derivations

**A — Direct VPC egress + Cloud NAT**
- NAT external IP: $0.005/h ([nat/pricing](https://cloud.google.com/nat/pricing), row "Static and ephemeral IP addresses used by Cloud NAT") × 730 = **$3.65**. Google publishes the monthly figure itself.
- NAT gateway uptime: `$0.0014 × the number of VM instances that are using the gateway` per hour, up to 32 instances; flat **$0.044/h** above that ([nat/pricing](https://cloud.google.com/nat/pricing)). One counted instance for a month = **$1.02**; the cap = **$32.12**. Whether a Cloud Run instance counts is **undocumented** (§4.1) — the range is the honest answer.
- NAT data processing: **$0.045/GiB**, inbound **and** outbound, "the data processing price is the same across all regions" ([nat/pricing](https://cloud.google.com/nat/pricing)). Do not repeat the common claim that this is ~2.5× the egress rate — Premium-Tier internet egress is $0.12/GiB, so NAT processing is roughly **one third** of it, layered on top (~+37%), and it also bills the *inbound* leg that egress pricing never charges.
- Internet egress, Premium Tier from us-central1/us-east1: first 1 GiB/month free to North America and to "Asia excl Korea, Indonesia", then $0.12/GiB; the "Australia, Indonesia, Korea, **South America**, Saudi Arabia" band has **no free row** and starts at $0.19/GiB ([network pricing](https://cloud.google.com/vpc/network-pricing)).
- ⚠️ A requires `egress: ALL_TRAFFIC`, so **all** outbound traffic — not just Shopee — pays NAT processing. That directly contradicts your "everything else keeps default egress" requirement.

**B — Serverless VPC Access connector + Cloud NAT**
- Connector minimum is **2 instances**, billed as Compute Engine VMs ([VPC pricing](https://cloud.google.com/vpc/pricing#serverless-vpc-pricing), [configure](https://docs.cloud.google.com/vpc/docs/configure-serverless-vpc-access)). Console default machine type is **e2-micro** at $0.008376428/h → 2 × 730 = **$12.23/mo**. Explicitly choosing f1-micro ($0.0076/h) gives $11.10, but Google warns shared-core connectors exhaust CPU credits under packet load.
- **Ratchet:** "If the connector scales up to the maximum number of instances, it does not scale back down," and "Decreasing the number of instances for existing connectors is not supported" — the only way back is to delete and recreate ([configure](https://docs.cloud.google.com/vpc/docs/configure-serverless-vpc-access)). At the default max of 10 that is **$61.15/mo, permanently**, until you recreate.
- Connector instances are real VMs, so the NAT gateway meter counts at least 2 → $2.04, plus the $3.65 NAT IP.
- B's one advantage: Google explicitly recommends it over Direct VPC egress *when Cloud NAT is involved* — "With Cloud NAT, you might experience cold start delays of 30s or more on instance startup when using Direct VPC egress. For better startup performance, we recommend using Serverless VPC Access connectors with Cloud NAT" ([vpc-direct-vpc](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc)). A 30 s cold start is fatal to a 3-second Shopee push ack unless `minInstances ≥ 1` absorbs it.

**C and D — the e2-micro proxy**
- VM: **$0**. "1 non-preemptible `e2-micro` VM instance per month in one of the following US regions: Oregon: `us-west1`. Iowa: `us-central1`. South Carolina: `us-east1`." and "Your Free Tier `e2-micro` instance limit is by time, not by instance… free until you have used a number of hours equal to the total hours in the current month" ([free tier](https://docs.cloud.google.com/free/docs/free-cloud-features)). One 24×7 instance consumes exactly the whole allowance.
- Disk: **$0** under 30 GB-months **pd-standard**.
- External IPv4: **not free-tier-covered.** "$0.005 / 1 hour" in use on a standard VM, with a token "free usage… limited to one hour per month per account" → 729 × $0.005 = **$3.645 ≈ $3.65/mo** ([network pricing](https://cloud.google.com/vpc/network-pricing)). This rate rose from $0.004 on 2024-02-01, SKU C054-7F72-A02E ([announcement](https://cloud.google.com/vpc/pricing-announce-external-ips)) — older $0.004 figures are stale.
- ⚠️ **Reserve the static IP only when you can attach it immediately.** A reserved-but-unattached static IP is **$0.01/h ≈ $7.30/mo**, double the in-use rate ([network pricing](https://cloud.google.com/vpc/network-pricing)). And a *static* IP keeps billing at $0.005/h even while the VM is **stopped** — "Google Cloud considers a static external IP address as in use if it is associated with a VM instance whether the instance is running or stopped." Only an *ephemeral* IP is released on stop, and an ephemeral IP is useless for a whitelist.
- D's internal hop: **free only in the same zone, over the internal IP, in the same VPC**. Cross-zone same-region is $0.01/GiB, cross-region NA↔NA is $0.02/GiB, and "All traffic to and from external IPv4 addresses leaves the zone — regardless of the destination" ([network pricing](https://cloud.google.com/vpc/network-pricing)). Dial the VM's internal IP, never its external one.
- Compute Engine free egress: "1 GB of outbound data transfer from North America to all region destinations (excluding China and Australia) per month" — Brazil/South America is **not** excluded as a destination, but the allowance only covers egress originating *in North America*.

**E — registering Google's published ranges: does not work**

`cloud.json` is real and is linked from Google's own docs: "Google also publishes a list of global and regional external IP addresses ranges available for customers' Google Cloud resources in cloud.json" ([Private Google Access](https://docs.cloud.google.com/vpc/docs/configure-private-google-access)). It fails for three independent reasons:

1. **No per-project or per-service dimension.** Every entry has exactly `ipv4Prefix`/`ipv6Prefix`, `service`, `scope`, and `service` has a single distinct value across the whole file: `"Google Cloud"`. Example entry: `{"ipv4Prefix": "34.1.208.0/20", "service": "Google Cloud", "scope": "africa-south1"}`. There is no "Cloud Run" or "App Hosting" value to filter on ([cloud.json](https://www.gstatic.com/ipranges/cloud.json)).
2. **Absurd size.** Measured 2026-09-03 (syncToken 1788444430476): **1,098 prefixes, 1,003 IPv4, 19,093,376 IPv4 addresses, 48 scopes**; us-central1 alone is 107 prefixes / **5,094,656 addresses**. Whitelisting that means whitelisting every Google Cloud customer in the region — the whitelist stops being a security control.
3. **Churn.** The file is regenerated continuously; the numbers above are valid only for that syncToken. Shopee's whitelist is a manually curated set, not a subscribed feed.

Separately, Cloud Run's default egress is explicitly non-static: "By default, a Cloud Run service connects to external endpoints on the internet using a dynamic IP address pool" ([static-outbound-ip](https://docs.cloud.google.com/run/docs/configuring/static-outbound-ip)). Google publishes no narrower list.

---

## 2. Per-option engineering profile

### A — Direct VPC egress + Cloud NAT + static IP

- **What is static:** the reserved external IPv4 on the NAT gateway. Stable across deploys, revisions, scale events, and Google's own maintenance.
- **SPOF:** none you own. Cloud NAT is a managed control plane — "the Cloud NAT gateway and the Cloud Router provide only a control plane and the packets don't pass through the NAT gateway or the Cloud Router" ([static-outbound-ip](https://docs.cloud.google.com/run/docs/configuring/static-outbound-ip)), and it "does not reduce the network bandwidth per VM" ([NAT overview](https://docs.cloud.google.com/nat/docs/overview)). Port exhaustion, not the gateway, is the scaling limit.
- **`apphosting.yaml`:** needs `egress: ALL_TRAFFIC` **together with** `networkInterfaces:` — a combination Firebase documents **nowhere**. The docs show `ALL_TRAFFIC` only with `connector:`, and `networkInterfaces:` only with the default `PRIVATE_RANGES_ONLY` ([App Hosting VPC](https://firebase.google.com/docs/app-hosting/vpc-network)). See §4.2 — this is a blocking unknown.
- **Functions gen2:** `gcloud run deploy … --network=… --subnet=… --vpc-egress=all-traffic`; Direct VPC egress is gen2-only and cannot be combined with a connector ([functions direct-vpc](https://docs.cloud.google.com/functions/docs/running/direct-vpc)).
- **NAT gateway flags for serverless:** `--endpoint-types=ENDPOINT_TYPE_VM`, `--nat-custom-subnet-ip-ranges=<your subnet>`, and `--min-ports-per-vm` set to **2×** the ports a single Cloud Run instance needs (4× for Private NAT). Manual IP allocation must cover "the sum of VM instances and Cloud Run instances that are served by the gateway" ([NAT product interactions](https://docs.cloud.google.com/nat/docs/nat-product-interactions)).
- **Subnet sizing:** `/26` minimum; Cloud Run reserves IPs in `/28` blocks and uses **2× as many IP addresses as instances** at steady state, holding them up to 20 minutes after scale-down ([vpc-direct-vpc](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc)).
- **Security:** the cleanest posture — no listener you own is exposed anywhere. Optional tightening via network tags in **egress** firewall rules, which are per-revision.
- **Latency:** the 30 s Cloud NAT cold-start warning, plus a general "connection establishment delays of a minute or more on instance startup," mitigated by an HTTP startup probe that tests an egress destination.

### B — Serverless VPC Access connector + Cloud NAT

- **What is static:** same NAT IP. Same guarantees as A.
- **SPOF:** connector instances are distributed across zones; the ratchet is a cost failure mode, not an availability one.
- **`apphosting.yaml`:** the **documented** shape — `runConfig.vpcAccess: { egress: ALL_TRAFFIC, connector: connector-id }` ([App Hosting VPC](https://firebase.google.com/docs/app-hosting/vpc-network)). Use IDs rather than fully qualified names for staging/production portability.
- **Functions gen2:** connector or Direct VPC egress, never both.
- **Security:** same as A.
- **Latency:** Google's own recommended pairing with Cloud NAT.
- **Cost trap:** the 2-instance floor and the one-way ratchet. Firebase's own docs are blunt: connectors require "payment for the underlying VM," and Direct VPC egress is "Simpler, faster, and less expensive."

### C — public-internet proxy VM with proxy auth

- **What is static:** the VM's reserved external IPv4.
- **SPOF:** one VM, and it is on the critical path for every Shopee call. Live migration is the default host-maintenance behaviour and preserves the IP, but the process has a "blackout" during which "the system clock appears to jump forward, up to 5 seconds" and disk/CPU/memory/network performance dips ([live migration](https://docs.cloud.google.com/compute/docs/instances/live-migration-process)) — in-flight requests can time out, so the Shopee client needs retries.
- **`apphosting.yaml`:** **nothing.** No VPC config at all — this is C's only real advantage and it neatly sidesteps §4.2.
- **Security: this is the disqualifier.** You cannot narrow the ingress rule to your own backend, because Cloud Run's egress is a dynamic pool. The best you could do is allow the region's `cloud.json` ranges — 5 million addresses in us-central1, i.e. every GCP customer — so in practice the proxy port is open to the internet behind a credential only. Add the default-network trap: a new project's auto-created network named `default` already carries `default-allow-ssh` (tcp:22 from 0.0.0.0/0), `default-allow-rdp` (tcp:3389 from 0.0.0.0/0), `default-allow-icmp`, and `default-allow-internal` (10.128.0.0/9), all sitting **above** the implied deny. "VPC defaults deny all ingress" is only true on a custom-mode VPC. If you build C, terminate TLS on the proxy hop (`proxyTls` in undici) so the `Proxy-Authorization` header is never in cleartext.
- Also pays internet egress on **both** hops.

### D — internal-IP proxy VM behind Direct VPC egress (no NAT) ✅

- **What is static:** the VM's reserved external IPv4, used only for the outbound hop it makes on your behalf. A VM with its own external IP satisfies Google's internet-access requirement directly — "The instance must have an external IP address" is the first of the alternatives, and Cloud NAT is the *other* one ([VPC overview](https://docs.cloud.google.com/vpc/docs/vpc)).
- **SPOF:** one VM, same live-migration caveats as C. This is the cost of the design.
- **`apphosting.yaml`:** the **documented** Direct VPC egress shape, with the default egress mode:
  ```yaml
  runConfig:
    vpcAccess:
      egress: PRIVATE_RANGES_ONLY   # default
      networkInterfaces:
        - network: my-network-id
          subnetwork: my-subnetwork-id
  ```
  ([App Hosting VPC](https://firebase.google.com/docs/app-hosting/vpc-network)). `PRIVATE_RANGES_ONLY` "Sends only traffic to internal addresses through the VPC network" ([vpc-direct-vpc](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc)) — which is *exactly* the stated requirement: the proxy's RFC 1918 address routes into the VPC, and every non-Shopee call keeps the ordinary egress path untouched. Supported internal ranges are RFC 1918, RFC 6598 (`100.64.0.0/10`) and Class E (`240.0.0.0/4`).
  ⚠️ **VPC access is runtime-only**, "not at build time (Cloud Build)" — a build step cannot reach Shopee from the whitelisted IP.
- **Functions gen2:** `--network`, `--subnet`, `--vpc-egress=private-ranges-only`. Both surfaces reach "Compute Engine VM instances, Memorystore instances, and any other resources with an internal IP address" ([connecting-vpc](https://docs.cloud.google.com/run/docs/configuring/connecting-vpc)). Direct VPC egress adds **no compute charge** — "you only pay for network egress (at the same rate as connectors). You do not pay any compute charges."
- **Region coupling:** the Cloud Run/App Hosting region "must match the region of your subnet." Combined with the free-tier VM regions, keep the backend in **us-central1 or us-east1** and put the VM in the same **zone** for free internal transfer.
- **Security:** custom-mode VPC (or delete the four `default-allow-*` rules), VM with **no** inbound exposure beyond one narrow allow — source = the Direct-VPC-egress subnet CIDR or a network tag/service account, target = the proxy tag, port = the proxy port. Egress from the VM stays implicitly open unless you write a deny/allow pair. Admin access via **IAP TCP forwarding** (`35.235.240.0/20` ingress on tcp:22 + `roles/iap.tunnelResourceAccessor`), never a public SSH rule ([IAP TCP forwarding](https://docs.cloud.google.com/iap/docs/using-tcp-forwarding)). **Do not use IAP as the data path** — "IAP's TCP forwarding feature isn't intended for bulk transfer of data. IAP reserves the right to rate-limit users abusing this service," plus a 1-hour idle disconnect.
- **Capacity:** e2-micro "sustains 2 vCPUs, each for 12.5% of CPU time totaling 25% CPU time" ([general-purpose machines](https://docs.cloud.google.com/compute/docs/general-purpose-machines)); bursting is opportunistic and "doesn't incur any additional charges," with **no documented duration** — size against the 25% baseline, not against any assumed burst window. E2 shared-core egress caps at 2 Gbps ([network bandwidth](https://docs.cloud.google.com/compute/docs/network-bandwidth)), so CPU binds long before the NIC.
- **Latency:** no Cloud NAT, so the 30 s NAT cold-start warning does not apply. The general Direct-VPC-egress startup delay still does — add an HTTP startup probe (see §4.9).

### Node client wiring (C and D)

Scope the proxy to Shopee calls only, per request, rather than process-wide:

```js
import { ProxyAgent, fetch } from 'undici';
const shopeeProxy = new ProxyAgent({
  uri: 'http://10.x.x.x:3128',
  token: `Basic ${Buffer.from('user:pass').toString('base64')}`,
});
await fetch(shopeeUrl, { dispatcher: shopeeProxy });
```

`dispatcher` in the fetch init is documented ([Node globals](https://nodejs.org/api/globals.html), [undici ProxyAgent](https://undici.nodejs.org/api/ProxyAgent)); `token` is a **pre-formatted** header value, so the scheme word must be included, and the older `auth` option is deprecated. The process-wide alternative (`NODE_USE_ENV_PROXY=1` / `--use-env-proxy`, honouring `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`) exists from **v22.21.0** — fetch from 22.21.0 or 24.0.0+, `node:http`/`node:https` from 22.21.0 or 24.5.0+ ([enterprise network configuration](https://nodejs.org/learn/http/enterprise-network-configuration)) — and a `GOOGLE_RUNTIME_VERSION` of 24.19.0 clears both bars. But it proxies *everything* that isn't in `NO_PROXY`, which is the opposite of the requirement, and a call site passing its own agent/dispatcher silently bypasses it. Prefer the per-request form. Note `http_proxy` (lowercase) **wins over** `HTTP_PROXY` if both are set — a stale lowercase value silently overrides your new one ([EnvHttpProxyAgent](https://undici.nodejs.org/api/EnvHttpProxyAgent)).

---

## 3. Recommendation

**Build D: a free-tier `e2-micro` forward proxy in the same zone as the backend, reached over its internal IP through Direct VPC egress with the default `PRIVATE_RANGES_ONLY`, making the outbound hop from its own reserved static external IPv4. ~$3.65/month — the IPv4 address is the entire bill.**

Four reasons, in order of weight:

1. **It uses the only App Hosting VPC combination Firebase actually documents.** Option A needs `egress: ALL_TRAFFIC` **plus** `networkInterfaces:`, a pairing that appears in no Firebase example, is not exposed in the App Hosting v1 or v1beta API at all, and whose validation lives in a closed rollout pipeline. If App Hosting rejects it, A collapses into B and the bill jumps from ~$5 to ~$18/month. D uses the documented default and cannot be blocked that way.
2. **It matches the stated requirement exactly.** `PRIVATE_RANGES_ONLY` routes *only* internal addresses into the VPC. Firestore, Google APIs, npm, everything else keeps default egress and pays no NAT processing. A and B force `ALL_TRAFFIC` and pull your entire outbound surface through the VPC — a broader blast radius, on both cost and correctness, than the problem justifies.
3. **It sidesteps the cold-start collision.** Google's own guidance says Direct VPC egress + Cloud NAT "might" cost 30 s or more on instance startup and recommends the *paid* connector instead. With a 3-second empty-body push ack, A is only safe with `minInstances ≥ 1` — which you may want anyway, but D removes the coupling entirely, since there is no NAT.
4. **Cost.** $3.65 vs $4.67–$35.77 (A) vs $17.92–$97 (B). The gap over A is small when NAT counts one instance and large when it counts the cap — and you cannot find out which without a bill (§4.1).

**Reject C** despite identical cost: the proxy would be internet-facing with credential-only auth, because there is no source CIDR you can pin — the dynamic egress pool is precisely the problem you set out to solve. **Reject E** outright: it is 19 million addresses that change hourly and identify no tenant.

**The honest cost of D is operational, not financial.** You own a Linux box: patching, the proxy daemon, monitoring, and — the real risk — the static IP must survive VM recreation, or the whitelist silently breaks and every Shopee call fails auth. Two mitigations to build in from day one: (i) never let autohealing or a rebuild hand the VM a fresh address — verify stateful IP retention *before* you register the IP with Shopee (§4.3); (ii) if you later find you want a managed instance group with autohealing, set `initialDelaySec` long enough to cover boot **and** the startup script that installs the proxy, and keep the autohealing health check deliberately conservative — Google's guidance is that it "should be more conservative than a load balancing health check," and probes failing for environmental reasons "can prompt automatic recreation of VMs that might be healthy" ([about-repair](https://docs.cloud.google.com/compute/docs/instance-groups/about-repair), [autohealing](https://docs.cloud.google.com/compute/docs/instance-groups/autohealing-instances-in-migs)).

**Switch to A** if either becomes true: (a) you confirm App Hosting accepts `ALL_TRAFFIC` + `networkInterfaces`, *and* you would rather pay ~$5–35/month than run a VM; or (b) the single-VM SPOF proves unacceptable in practice. **Switch to B** only if A's YAML combination is rejected and you still want a managed path.

**One repo-level note:** the VPC, subnet, firewall rules, static IP reservation and VM are infrastructure that must exist *before* any manifest change means anything — none of it belongs in a PR diff, and `apphosting.yaml` is runtime-only, never build-time. Surface it as an ops step rather than a TODO. And keep region ids out of source: read them through the environment, per `no-hardcoded-gcp-region`.

---

## 4. Facts that could **not** be verified

1. **Does a Cloud Run instance under Direct VPC egress count as a "VM instance" for the Cloud NAT `$0.0014`/instance-hour meter?** No Google page says. The pricing page says only "Google Cloud counts VM instances that get a NAT assignment as using the gateway," and its worked examples are Compute Engine ones. Circumstantially yes — the gateway must be set to `--endpoint-types=ENDPOINT_TYPE_VM`, and IP-allocation guidance says to cover "the sum of VM instances and Cloud Run instances." **Exposure is bounded: $1.02/mo best case, $32.12/mo cap.** Resolve by reading SKU `32E2-4EFC-EF9F` on a real bill, or ask GCP support. *This is the one number that makes option A's total a range instead of a figure.*
2. **Does `apphosting.yaml` accept `egress: ALL_TRAFFIC` together with `networkInterfaces:`?** Undocumented. The underlying Cloud Run `VpcAccess` message treats `egress`, `connector` and `networkInterfaces` as independent siblings and permits it, but the App Hosting v1/v1beta discovery documents expose **no** `vpcAccess` field at all (`RunConfig` is exactly `cpu, minInstances, memoryMib, concurrency, maxInstances`), so validation lives in the closed rollout pipeline. **This combination is required for option A on App Hosting.** Test on a staging backend before designing on it; fallback is the paid connector (+$11–12/mo).
3. **Can a recreated VM (or a MIG autohealing event) keep the *same* reserved static external IPv4?** Stateful IP configuration exists in MIGs but was not verified. If it cannot, autohealing rotates the whitelisted IP and Shopee auth breaks silently. **Highest-risk unknown in options C and D.**
4. **Which egress band does Shopee's BR partner endpoint fall in?** "Asia excl Korea, Indonesia" is $0.12/GiB with a free first GiB; the band containing South America and Indonesia is $0.19/GiB with **no** free row. Whether that South America band has a free 1 GiB row at all could not be confirmed from the rendered table. ~60% swing on egress — immaterial at API volumes, decisive if you ever bulk-sync.
5. **Is the free-tier `e2-micro` already consumed on this billing account?** The allowance is per *billing account*, not per project, and is measured in hours pooled across us-west1/us-central1/us-east1. With a legacy project, a staging project and the future Enterprise project, one existing always-on e2-micro anywhere makes options C and D cost the full VM rate instead of $0. **Check before committing.**
6. **Did Cloud NAT + Public NAT over Direct VPC egress ever leave Preview?** Announced Preview 2024-03-14; the release notes record **Private** NAT reaching GA on 2025-10-21 with no matching Public NAT GA entry. The static-outbound-IP guide carries no Preview banner, which suggests GA, but no explicit statement was found.
7. **Does undici's `setGlobalDispatcher()` (npm package) affect Node's *built-in* global `fetch`?** Neither project documents it, and "Installing undici from npm does not replace the built-in globals." Rely only on the per-request `dispatcher` option, importing `fetch` from `undici`, `install()`, or `NODE_USE_ENV_PROXY` — never on the undocumented shared-symbol behaviour.
8. **Is Cloud NAT billed if a gateway exists in the VPC but egress is `private-ranges-only` and no public traffic ever traverses it?** Not found. Relevant only if you keep a NAT gateway as a standby fallback alongside option D.
9. **Does Firebase App Hosting expose the Cloud Run startup-probe knob?** That probe is Google's documented mitigation for the Direct-VPC-egress startup delay. If App Hosting does not expose it, the mitigation reduces to `minInstances`.
10. **Does Shopee's IP whitelist accept more than one address, or a CIDR?** This is a Shopee-side question and it decides whether HA is even possible: with a single permitted IP, *every* option is a single-IP design and the SPOF argument against D largely evaporates. Answer it before designing redundancy.
11. **Compute Engine snapshot free allowance:** the word "snapshot" does not appear on the current free-tier page. Older third-party guides cite 5 GB-months; treat as **not found**, not as granted.
12. **Whether the Cloud Run free-tier discount is applied at the active or the idle rate** — it materially changes the net `minInstances: 1` bill ($9.86 gross vs ~$8.51 net if applied at idle). The page says only that it "is applied as a spending based discount using Tier 1 pricing."
13. **Region attribution of the f1-micro ($0.0076/h) and e2-micro ($0.008376428/h) hourly prices** — read from the pricing page's default region (Iowa/us-central1), corroborated by the sibling e2-medium value, but not from an explicit region label. **No us-east1 figure was checked.** Per-GB prices for pd-standard / pd-balanced / pd-ssd were also **not found**.
14. **How often Compute Engine host-maintenance (live migration) events occur** — needed to size the retry/timeout budget for requests in flight through the proxy during a blackout.
15. **Whether Cloud Run permits 0.5 vCPU together with `minInstances`** in all configurations — the $6.57/month figure is a straight application of the per-vCPU-second rate, not a confirmed supported shape.

**Retrieval caveat on every Google pricing figure above:** `cloud.google.com/nat/pricing`, `/vpc/network-pricing`, `/vpc/pricing` and `/run/pricing` render their tables client-side and truncate on ordinary fetches; the figures here were recovered from the pages' embedded data payloads. `docs.cloud.google.com/nat/pricing` 301-redirects back to the same URL, so it is not an escape hatch. Eyeball the live tables in a browser before committing any number to a budget.