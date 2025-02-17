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

// Platform bilgisini güvenli şekilde al
const getPlatform = (): string => {
  try {
    // Modern yöntem
    if ('userAgentData' in navigator && navigator.userAgentData?.platform) {
      return navigator.userAgentData.platform;
    }
    // Eski yöntem (deprecated ama hala çalışıyor)
    else if (navigator.platform) {
      return navigator.platform;
    }
    // Fallback
    return 'unknown';
  } catch {
    return 'unknown';
  }
};

// Hardware özellikleri al
const getHardwareInfo = (): string[] => {
  return [
    navigator.userAgent,
    `${screen.width},${screen.height}`,
    `${screen.colorDepth},${screen.pixelDepth}`,
    navigator.language,
    navigator.hardwareConcurrency?.toString() || '',
    getPlatform(),
    new Date().getTimezoneOffset().toString(),
    navigator.deviceMemory?.toString() || '',
    navigator.maxTouchPoints?.toString() || ''
  ];
};

// Hardware signature oluştur
const generateHardwareSignature = async (): Promise<string> => {
  const hardwareInfo = getHardwareInfo();
  const stableInfo = hardwareInfo.slice(0, 6); // Daha stabil özellikleri al
  return await sha256(stableInfo.join('|'));
};

// Ana fingerprint oluşturma fonksiyonu
export const generateEnhancedFingerprint = async (): Promise<{
  fingerprint: string;
  hardwareSignature: string;
}> => {
  try {
    // 1. Hardware bilgileri
    const hardwareInfo = getHardwareInfo();
    const hardwareSignature = await generateHardwareSignature();

    // 2. Canvas fingerprint
    const canvasFingerprint = getCanvasFingerprint();

    // 3. Stored ID
    const storedId = getStoredId();

    // 4. Tarayıcı özellikleri
    const browserFeatures = [
      'FileReader' in window,
      'WebSocket' in window,
      'localStorage' in window,
      'indexedDB' in window,
      'Intl' in window,
      'WebGL2RenderingContext' in window,
      'Bluetooth' in navigator,
      'speechSynthesis' in window
    ].map(f => f ? '1' : '0').join('');

    // 5. Medya özellikleri
    let mediaFeatures = '';
    if ('mediaDevices' in navigator) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        mediaFeatures = devices.map(d => d.kind).join(',');
      } catch {
        mediaFeatures = 'error';
      }
    }

    // Birincil fingerprint oluştur
    const components = [
      hardwareInfo.join('|'),
      canvasFingerprint,
      storedId,
      browserFeatures,
      mediaFeatures
    ];

    const primaryFingerprint = await sha256(components.join('::'));

    // Debug log
    console.debug('Fingerprint bileşenleri oluşturuldu', {
      hardwareSignatureLength: hardwareSignature.length,
      fingerprintLength: primaryFingerprint.length,
      hasCanvas: !!canvasFingerprint,
      hasStoredId: !!storedId
    });

    return {
      fingerprint: primaryFingerprint,
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
      platform: getPlatform(),
      language: navigator.language,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints
    },
    hasLocalStorage: 'localStorage' in window,
    hasWebGL: 'WebGL2RenderingContext' in window,
    timestamp: new Date().toISOString()
  };
};