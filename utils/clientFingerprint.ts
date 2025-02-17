// src/utils/clientFingerprint.ts

// Canvas fingerprint oluşturma
const getCanvasFingerprint = (): string => {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    // Canvas boyutunu ayarla
    canvas.width = 200;
    canvas.height = 200;

    // Temel metin özellikleri
    ctx.textBaseline = "alphabetic";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";
    
    // Benzersiz bir metin ekle
    ctx.fillText("YTU-Attendance-2024", 2, 15);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("YTU-Attendance-2024", 4, 17);

    // Ek grafik öğeleri
    ctx.beginPath();
    ctx.arc(50, 50, 25, 0, Math.PI * 2);
    ctx.fillStyle = "#FF0000";
    ctx.fill();

    return canvas.toDataURL();
  } catch (error) {
    console.error('Canvas fingerprint hatası:', error);
    return '';
  }
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
  try {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  } catch (error) {
    console.error('Hash oluşturma hatası:', error);
    throw new Error('Hash oluşturulamadı');
  }
}

// Ana fingerprint oluşturma fonksiyonu
export const generateEnhancedFingerprint = async (): Promise<{
  fingerprint: string;
  hardwareSignature: string;
}> => {
  try {
    // 1. Sadece stabil hardware bilgileri
    const stableHardwareInfo = [
      `${screen.width},${screen.height}`,
      `${screen.colorDepth}`,
      navigator.hardwareConcurrency?.toString() || '',
      navigator.platform || '',
      navigator.userAgent
    ].join('|');

    // 2. Hardware signature (değişmesi çok zor)
    const hardwareSignature = await sha256(stableHardwareInfo);

    // 3. İkincil özellikler (fingerprint için)
    const secondaryFeatures = [
      navigator.language,
      new Date().getTimezoneOffset(),
      'deviceMemory' in navigator ? navigator.deviceMemory : '',
      'maxTouchPoints' in navigator ? navigator.maxTouchPoints : '',
      getCanvasFingerprint(),
      getStoredId()
    ].join('|');

    // 4. Ana fingerprint
    const fingerprint = await sha256(stableHardwareInfo + "::" + secondaryFeatures);

    // Debug log
    console.debug('Fingerprint bileşenleri oluşturuldu', {
      hardwareSignatureLength: hardwareSignature.length,
      fingerprintLength: fingerprint.length,
      hasCanvas: !!getCanvasFingerprint(),
      hasStoredId: !!getStoredId()
    });

    return {
      fingerprint,
      hardwareSignature
    };
  } catch (error) {
    console.error('Fingerprint oluşturma hatası:', error);
    throw new Error('Cihaz tanımlama başarısız');
  }
};

// Fingerprint geçerliliğini kontrol et
export const isValidFingerprint = (
  fingerprint: string,
  hardwareSignature: string
): boolean => {
  return (
    typeof fingerprint === 'string' &&
    typeof hardwareSignature === 'string' &&
    fingerprint.length >= 32 &&
    hardwareSignature.length >= 32
  );
};

// Debug fonksiyonu
export const getDeviceDebugInfo = async (): Promise<object> => {
  const { fingerprint, hardwareSignature } = await generateEnhancedFingerprint();
  return {
    fingerprint: fingerprint.slice(0, 8) + '...',
    hardwareSignature: hardwareSignature.slice(0, 8) + '...',
    screen: {
      width: screen.width,
      height: screen.height,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth
    },
    navigator: {
      platform: navigator.platform || 'unknown',
      language: navigator.language,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: 'deviceMemory' in navigator ? navigator.deviceMemory : undefined,
      maxTouchPoints: navigator.maxTouchPoints
    },
    hasLocalStorage: 'localStorage' in window,
    hasWebGL: 'WebGL2RenderingContext' in window,
    timestamp: new Date().toISOString()
  };
};