// utils/clientFingerprint.ts

// Canvas fingerprint oluşturma
const getCanvasFingerprint = (): string => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Canvas boyutunu ayarla
  canvas.width = 200;
  canvas.height = 200;

  // Metin özellikleri
  ctx.textBaseline = "top";
  ctx.font = "14px 'Arial'";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f60";
  ctx.fillRect(125,1,62,20);
  ctx.fillStyle = "#069";
  
  // Benzersiz bir metin ekle
  ctx.fillText("YTU-Attendance-2024", 2, 15);
  ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
  ctx.fillText("YTU-Attendance-2024", 4, 17);

  return canvas.toDataURL();
};

// Saklanan ID'yi al veya oluştur
const getStoredId = (): string => {
  const key = 'ytu_device_id';
  let storedId = localStorage.getItem(key);
  
  if (!storedId) {
    storedId = crypto.randomUUID();
    localStorage.setItem(key, storedId);
  }
  
  return storedId;
};

// SHA-256 hash fonksiyonu
async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

// Ana fingerprint oluşturma fonksiyonu
export const generateEnhancedFingerprint = async (): Promise<string> => {
  try {
    // 1. Temel cihaz bilgileri
    const deviceInfo = [
      navigator.userAgent,
      screen.width,
      screen.height,
      navigator.language,
      navigator.hardwareConcurrency,
      navigator.platform,
      screen.colorDepth,
      screen.pixelDepth,
      window.devicePixelRatio,
      new Date().getTimezoneOffset()
    ].join('|');

    // 2. Canvas fingerprint
    const canvasFingerprint = getCanvasFingerprint();

    // 3. Saklanan benzersiz ID
    const storedId = getStoredId();

    // 4. IP adresi
    const ipResponse = await fetch('https://api.ipify.org?format=json');
    const { ip } = await ipResponse.json();

    // Tüm bileşenleri birleştir ve hash'le
    const combinedFingerprint = [
      deviceInfo,
      canvasFingerprint,
      storedId,
      ip
    ].join('::');

    const finalFingerprint = await sha256(combinedFingerprint);
    return finalFingerprint;

  } catch (error) {
    console.error('Fingerprint oluşturma hatası:', error);
    // Hata durumunda sadece stored ID'yi kullan
    return getStoredId();
  }
};