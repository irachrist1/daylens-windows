# Windows Code-Signing Setup

This document explains how to eliminate the SmartScreen "Windows protected your PC" warning
and the browser "this file may be harmful" download warning for Daylens on Windows.

## Why these warnings appear

Windows SmartScreen and browser download protection check whether an `.exe` has an
Authenticode signature from a trusted certificate authority. An unsigned or unknown installer
always triggers a full warning screen. A signed installer with an EV certificate clears
SmartScreen on first install. A signed OV installer clears it after enough users have
downloaded it without reporting it (can take weeks).

## Option A — EV Code-Signing Certificate (recommended)

An Extended Validation (EV) certificate grants SmartScreen reputation immediately. The
downside is that EV certs require a physical USB hardware token (HSM) for signing, which
means the build must run on a machine that has the token plugged in — or via a cloud HSM.

**Vendors (roughly $300-500/yr):**
- DigiCert: https://www.digicert.com/signing/code-signing-certificates
- Sectigo: https://sectigo.com/ssl-certificates-tls/code-signing
- GlobalSign: https://www.globalsign.com/en/code-signing-certificate

**Steps:**
1. Purchase an EV certificate. The CA will verify your identity (takes 1-5 business days).
2. The CA ships a USB hardware token (YubiKey or similar) with the private key.
3. Export the public certificate as a PFX (you set the password during export).
4. Add the three GitHub secrets (see below).
5. For CI, use a cloud signing service like DigiCert KeyLocker or SSL.com eSigner to avoid
   shipping the physical token — these services expose the private key via an API that
   `signtool` can call remotely. Contact the CA for setup docs.

## Option B — OV Code-Signing Certificate (budget path)

An Organization Validation certificate is cheaper and can be stored as a PFX file
(no hardware token required), so CI signing is simpler. SmartScreen will still warn on
first run until the installer has enough download history.

**Vendors (~$100-200/yr):**
- Sectigo: https://sectigo.com/ssl-certificates-tls/code-signing
- Comodo/SSL.com: https://www.ssl.com/certificates/code-signing/

**Steps:**
1. Purchase an OV certificate. Verify your identity with the CA.
2. Download the PFX file with the private key and your chosen password.
3. Add the three GitHub secrets (see below).

## Option C — Microsoft Store (no cert required)

Apps distributed through the Microsoft Store are signed during Store certification and
bypass SmartScreen entirely. The `release-windows-store.yml` workflow already builds the
`.appx` package. Submit it at https://partner.microsoft.com/en-us/dashboard to get a Store
listing approved. Once live, set `DAYLENS_WINDOWS_STORE_URL` in the daylens-web Vercel
environment to redirect the Windows download button to the Store.

## Adding the certificate to GitHub Actions

Once you have a PFX file and password, add three repository secrets:

```bash
# 1. Base64-encode the PFX and copy it to your clipboard
base64 -i your-cert.pfx | pbcopy      # macOS
# base64 your-cert.pfx | xclip        # Linux

# 2. Set the secrets (you will be prompted to paste each value)
gh secret set WIN_CERTIFICATE_FILE     --repo irachrist1/daylens
gh secret set WIN_CERTIFICATE_PASSWORD --repo irachrist1/daylens
gh secret set WIN_CERT_SUBJECT_NAME    --repo irachrist1/daylens
# WIN_CERT_SUBJECT_NAME is the Common Name on your certificate, e.g. "Daylens"
```

Verify they appear:
```bash
gh secret list --repo irachrist1/daylens
```

## Triggering a signed Windows release

The Windows release workflow runs on `v{VERSION}-win` tags:

```bash
# Tag the commit you want to ship (must be an annotated tag)
git tag -a v1.0.36-win -m "Windows release v1.0.36"
git push origin v1.0.36-win
```

Or trigger it manually via GitHub Actions → Release Windows → Run workflow, entering
the version number and git tag.

## How auto-updates work after signing

Once a signed build is released:

1. Users who already have Daylens installed receive a background update check 10 seconds
   after launch.
2. If a newer version is found, `electron-updater` downloads the new installer silently
   in the background.
3. On next app quit, the new installer runs automatically (`autoInstallOnAppQuit = true`).
4. The user opens Daylens again and is on the new version — no manual download needed.

The GitHub release must include `latest.yml` (published by the Windows release workflow)
for `electron-updater` to find the new version. Verify it is present after each release:

```bash
gh release view v1.0.36 --repo irachrist1/daylens --json assets --jq '[.assets[].name]'
# Should include: "latest.yml"
```
