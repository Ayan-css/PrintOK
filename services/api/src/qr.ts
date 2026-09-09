/**
 * QR Code Generator for PrintOk
 * Produces real scannable QR codes encoding the customer upload URL.
 */
import QRCode from 'qrcode';

/**
 * Generate a real scannable QR code as a PNG Data URI.
 * @param targetUrl The full URL the QR code should encode (e.g. customer upload page)
 * @returns Base64-encoded PNG Data URI string
 */
export async function generateQrCodeDataUrl(targetUrl: string): Promise<string> {
  return QRCode.toDataURL(targetUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 300,
    color: {
      dark: '#0d0d0d',
      light: '#ffffff',
    },
  });
}
