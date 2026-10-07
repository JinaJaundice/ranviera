# Security policy

This policy explains how to report a vulnerability in Ranviera and what to expect after a report.

## Reporting a vulnerability

Please report a vulnerability privately and do not open a public issue. Use the private vulnerability report of the repository on GitHub, which is the button 'Report a vulnerability' under the Security tab of https://github.com/JinaJaundice/ranviera.

A report is most useful when it gives the version, the operating system, the steps to reproduce the problem and the effect that it has. Please do not include a real `~/.claude` folder, a real credential or any other person's data.

## What the authors will do

The maintainer reads every report and replies when they can. The project gives no promised time for an acknowledgement or for a fix, and it sets no fixed period of coordinated disclosure. The maintainer will tell the reporter what they find, and will credit a reporter in the release notes where the reporter agrees.

## Supported versions

Only the latest release receives security fixes.

## Scope

The following are in scope:

- the local server and its API, including the token that every request must carry
- the installer of hooks and the way it edits `settings.json`
- the Electron shell, its content security policy, its permission handling and its navigation limits
- the build and release workflows, including the checksums and the build attestations
- the handling of a person's files, which must stay on their computer.

The following are out of scope:

- Claude Code itself, which Anthropic maintains. Vulnerabilities in Claude Code should be reported to Anthropic through its own programme.
- a problem that needs an attacker who already has full control of the person's account on their computer.

## Checking a download

Each release carries a file of SHA-256 checksums and a build attestation. The README explains how to verify both.

## Non-affiliation

Ranviera is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.
