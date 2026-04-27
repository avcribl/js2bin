# Security Policy

## Supported Versions

js2bin is actively maintained. Security fixes are applied to the latest release only.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you believe you have found a security vulnerability in js2bin, please submit a report through Cribl's Vulnerability Disclosure Program:

**[cribl.io/vulnerability-disclosure-program](https://cribl.io/vulnerability-disclosure-program/)**

Include as much of the following as possible:

- A description of the vulnerability and its potential impact
- The version of js2bin affected
- Steps to reproduce or proof-of-concept code
- Any suggested mitigations you are aware of

The Cribl Security team will acknowledge receipt of your report, conduct a thorough investigation, and take appropriate action for resolution.

## Disclosure Policy

Cribl's vulnerability disclosure program follows [Bugcrowd's Standard Disclosure Terms](https://www.bugcrowd.com/resources/essentials/standard-disclosure-terms/). Researchers participating in this program agree to those terms.

We ask that you:

- Communicate about potential vulnerabilities responsibly, providing sufficient time and information for our team to validate and address potential issues
- Make every effort to avoid privacy violations, degradation of user experience, disruption to production systems, and destruction of data during security testing
- Refrain from publicly disclosing unverified vulnerabilities until our team has had time to validate and address reported issues and has provided written authorization for disclosure

Disclosure timelines may vary depending on the complexity and severity of the issue, the availability of remediation, and coordination requirements with third parties.

When a reported vulnerability is confirmed, Cribl will investigate, develop a fix or mitigation, and coordinate disclosure with the reporting researcher when applicable. Cribl may assign a CVE identifier to eligible vulnerabilities and publish a security advisory describing the issue, affected versions, and remediation guidance.

Researchers who report vulnerabilities may be publicly acknowledged in the advisory or CVE record unless they request to remain anonymous.

## Security Considerations for Users

js2bin bundles a Node.js application into a native executable. Because it wraps and executes arbitrary Node.js code:

- **Always pin to a specific commit SHA** when using js2bin as a dependency in a build pipeline rather than referencing a branch or tag, which are mutable
- **Treat js2bin as build-critical infrastructure** — changes to it should receive the same review scrutiny as changes to your application code

## Contact

- Security issues: [cribl.io/vulnerability-disclosure-program](https://cribl.io/vulnerability-disclosure-program/)
