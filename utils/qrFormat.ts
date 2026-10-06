// utils/qrFormat.ts (sunucu ve istemci ortak)
//
// QR içeriği: "YTU:<hafta>:<geçerlilik-saniye>:<konum>:<imza>"
//  - Kısa ve yalnızca büyük harf/rakam/":" içerir: QR "alfanümerik" modda
//    25x25 kareye sığar, uzaktan okunması kolaylaşır.
//  - Konum: O = okul, E = ev (öğretmen panelinden seçilir)
//  - İmza: öğretmen şifresiyle üretilen HMAC'in kısaltılmış hali. Kod herkese
//    açık olduğu için imzasız bir QR'ı herkes üretebilirdi (ör. derse gelmeden
//    kampüste istediği hafta için yoklama vermek). İmzayı yalnızca şifreyi
//    bilen öğretmen paneli üretebilir; sunucu her yoklamada doğrular.

export type PlaceCode = 'O' | 'E';

export interface QrPayload {
  week: number;
  expiresAtSec: number;
  place: PlaceCode;
  signature: string;
}

export const SIGNATURE_LENGTH = 6;

// İmzalanan metin
export function signingMessage(week: number, expiresAtSec: number, place: PlaceCode): string {
  return `${week}:${expiresAtSec}:${place}`;
}

// HMAC çıktısının ilk 4 baytından 6 karakterlik (0-9A-Z) imza üretir
export function signatureFromDigest(digest: Uint8Array): string {
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return (value % Math.pow(36, SIGNATURE_LENGTH)).toString(36).toUpperCase().padStart(SIGNATURE_LENGTH, '0');
}

export function buildQrPayload(payload: QrPayload): string {
  return `YTU:${payload.week}:${payload.expiresAtSec}:${payload.place}:${payload.signature}`;
}

export function parseQrPayload(text: string): QrPayload | null {
  const match = /^YTU:(\d{1,2}):(\d{9,11}):([OE]):([0-9A-Z]{6})$/.exec(text.trim());
  if (!match) return null;
  return {
    week: Number(match[1]),
    expiresAtSec: Number(match[2]),
    place: match[3] as PlaceCode,
    signature: match[4]
  };
}

// Uygulamanın önceki sürümlerinin ürettiği QR'lar (imzasız) - kullanıcıya
// anlamlı bir mesaj gösterebilmek için tanınır ama kabul edilmez
export function isLegacyQr(text: string): boolean {
  const trimmed = text.trim();
  if (/^YTU:\d{1,2}:\d{9,11}(:[OE])?$/.test(trimmed)) return true;
  try {
    const data = JSON.parse(trimmed);
    return !!data && Number.isInteger(data.week) && typeof data.validUntil === 'number';
  } catch {
    return false;
  }
}
