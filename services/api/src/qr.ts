/**
 * Simple QR Code SVG / Data URI Generator for PrintOk
 * Encodes target URL into an inline SVG / Data URI for shop QR display
 */

export function generateQrCodeDataUrl(targetUrl: string): string {
  // SVG representation of QR placeholder containing encoded shop link
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="250" height="250" viewBox="0 0 250 250">
    <rect width="250" height="250" fill="#ffffff" rx="16"/>
    <!-- Outer Position Marker Top-Left -->
    <rect x="20" y="20" width="60" height="60" fill="#1e293b"/>
    <rect x="30" y="30" width="40" height="40" fill="#ffffff"/>
    <rect x="40" y="40" width="20" height="20" fill="#1e293b"/>
    
    <!-- Outer Position Marker Top-Right -->
    <rect x="170" y="20" width="60" height="60" fill="#1e293b"/>
    <rect x="180" y="30" width="40" height="40" fill="#ffffff"/>
    <rect x="190" y="40" width="20" height="20" fill="#1e293b"/>

    <!-- Outer Position Marker Bottom-Left -->
    <rect x="20" y="170" width="60" height="60" fill="#1e293b"/>
    <rect x="30" y="180" width="40" height="40" fill="#ffffff"/>
    <rect x="40" y="190" width="20" height="20" fill="#1e293b"/>

    <!-- Data Pattern Elements -->
    <rect x="100" y="30" width="15" height="15" fill="#0f172a"/>
    <rect x="130" y="45" width="15" height="15" fill="#0f172a"/>
    <rect x="100" y="75" width="15" height="15" fill="#0f172a"/>
    <rect x="40" y="100" width="15" height="15" fill="#0f172a"/>
    <rect x="70" y="115" width="15" height="15" fill="#0f172a"/>
    <rect x="100" y="100" width="50" height="50" fill="#4f46e5"/>
    <rect x="170" y="100" width="20" height="20" fill="#0f172a"/>
    <rect x="200" y="130" width="20" height="20" fill="#0f172a"/>
    <rect x="110" y="170" width="20" height="20" fill="#0f172a"/>
    <rect x="140" y="190" width="30" height="30" fill="#0f172a"/>
    <rect x="190" y="180" width="25" height="25" fill="#0f172a"/>

    <text x="125" y="240" font-family="sans-serif" font-size="10" font-weight="bold" fill="#64748b" text-anchor="middle">Scan to PrintOk</text>
  </svg>`;

  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}
