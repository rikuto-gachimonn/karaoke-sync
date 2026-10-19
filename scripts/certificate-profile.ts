import { X509Certificate, randomUUID } from 'node:crypto';

export function certificateProfile(der: Buffer): string {
  const certificate = new X509Certificate(der);
  if (!certificate.ca) throw new Error('公開CA証明書だけを共有できます');
  const identifier = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>local.karaokesync.ca.${identifier}</string>
<key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadDisplayName</key><string>KaraokeSync Local Test CA</string>
<key>PayloadDescription</key><string>Local test CA only. SHA256: ${certificate.fingerprint256}</string>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>local.karaokesync.root.${identifier}</string>
<key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadDisplayName</key><string>KaraokeSync Local Test CA</string>
<key>PayloadContent</key><data>${certificate.raw.toString('base64')}</data>
</dict></array></dict></plist>`;
}
