// utils/qrPhoto.ts (istemci)
// Canlı kamera açılamadığında yedek yol: öğrenci telefonun kendi kamera
// uygulamasıyla fotoğraf çeker (<input capture>), QR fotoğraftan okunur.
// Bu yol tarayıcının kamera iznine ihtiyaç duymaz.

import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

const MAX_SIDE = 2400; // büyük fotoğraflar küçültülür (iOS canvas sınırı ve hız için)
const PHOTO_ELEMENT_ID = 'qr-photo-scan-area';

async function downscale(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale === 1) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    return blob ? new File([blob], 'qr.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fotoğraftaki QR kodun metnini döndürür; bulunamazsa hata fırlatır. */
export async function scanQrFromPhoto(file: File): Promise<string> {
  let element = document.getElementById(PHOTO_ELEMENT_ID);
  if (!element) {
    element = document.createElement('div');
    element.id = PHOTO_ELEMENT_ID;
    element.style.display = 'none';
    document.body.appendChild(element);
  }

  const scanner = new Html5Qrcode(PHOTO_ELEMENT_ID, {
    formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
    useBarCodeDetectorIfSupported: true,
    verbose: false
  });
  try {
    return await scanner.scanFile(await downscale(file), false);
  } finally {
    try {
      scanner.clear();
    } catch {
      // zaten temiz
    }
  }
}
