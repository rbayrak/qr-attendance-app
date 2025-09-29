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

    // YENİ: Daha karmaşık çizimler ekleyelim
    ctx.beginPath();
    ctx.moveTo(75, 75);
    ctx.lineTo(125, 125);
    ctx.lineTo(125, 75);
    ctx.fillStyle = "#0000FF";
    ctx.fill();
    
    // YENİ: Farklı renk ve opacity değerleri
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = `rgba(${i * 20}, ${255 - i * 20}, ${i * 10}, 0.${i})`;
      ctx.fillRect(10 + i * 15, 100, 10, 10);
    }
 
    return canvas.toDataURL();
  } catch (error) {
    console.error('Canvas fingerprint hatası:', error);
    return '';
  }
};

// YENİ: WebGL bilgisi alma fonksiyonu - TYPE SAFE
const getWebGLInfo = (): string => {
  try {
    const canvas = document.createElement('canvas');
    // WebGLRenderingContext tipini belirtelim
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
    if (!gl) return 'no-webgl';
    
    // Tip güvenliği için any kullanımı
    let vendor = 'unknown';
    let renderer = 'unknown';
    
    try {
      // Extension tiplemesi için daha güvenli yöntem
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        // Sabitleri any tipine dönüştürerek kullan
        vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL as number) || 'unknown';
        renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL as number) || 'unknown';
      }
    } catch (e) {
      // Extension hata verirse devam et
    }
    
    // Standart GL sabitleri için doğrudan erişim
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    
    // MAX_VIEWPORT_DIMS bir dizi döndürür, güvenli şekilde işleyelim
    const maxViewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const viewportString = maxViewportDims ? `${maxViewportDims[0]}x${maxViewportDims[1]}` : 'unknown';
    
    return `${vendor}|${renderer}|${maxTextureSize}|${viewportString}`;
  } catch (e) {
    return 'webgl-error';
  }
};

// YENİ: Font listesi kontrolü
const getFontList = (): string => {
  const baseFonts = ['monospace', 'sans-serif', 'serif'];
  const fontList = [
    'Arial', 'Courier New', 'Georgia', 'Times New Roman', 
    'Verdana', 'Tahoma', 'Trebuchet MS', 'Roboto', 'Helvetica'
  ];
  
  const testString = 'mmmmmmmmlli';
  const testSize = '72px';
  
  try {
    const h = document.getElementsByTagName('body')[0];
    
    const s = document.createElement('span');
    s.style.fontSize = testSize;
    s.innerHTML = testString;
    const defaultWidth: Record<string, number> = {};
    const defaultHeight: Record<string, number> = {};
    
    for (const baseFont of baseFonts) {
      s.style.fontFamily = baseFont;
      h.appendChild(s);
      defaultWidth[baseFont] = s.offsetWidth;
      defaultHeight[baseFont] = s.offsetHeight;
      h.removeChild(s);
    }
    
    const result: string[] = [];
    for (const font of fontList) {
      let detected = true;
      for (const baseFont of baseFonts) {
        s.style.fontFamily = `${font},${baseFont}`;
        h.appendChild(s);
        const matched = (s.offsetWidth !== defaultWidth[baseFont] || 
                        s.offsetHeight !== defaultHeight[baseFont]);
        h.removeChild(s);
        if (!matched) {
          detected = false;
          break;
        }
      }
      if (detected) result.push(font);
    }
    
    return result.join(',');
  } catch (e) {
    return 'font-detection-error';
  }
};

// YENİ: Ses ve video ekipmanı bilgileri
const getMediaDevicesInfo = async (): Promise<string> => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    return 'no-media-devices';
  }
  
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioinput = devices.filter(device => device.kind === 'audioinput').length;
    const videoinput = devices.filter(device => device.kind === 'videoinput').length;
    const audiooutput = devices.filter(device => device.kind === 'audiooutput').length;
    
    return `audio:${audioinput},video:${videoinput},speaker:${audiooutput}`;
  } catch (e) {
    return 'media-devices-error';
  }
};
 
// Saklanan ID'yi al veya oluştur
const getStoredId = (): string => {
  const key = 'ytu_device_id';
  let storedId = localStorage.getItem(key);
  
  if (!storedId) {
    // Sabit değerlerden oluşan ID kullan
    const hardwareBase = getSafeHardwareID();
    
    // Tüm tarayıcı sıfırlamalarda bile aynı kalacak özellikleri kullan
    storedId = `ytu-${hardwareBase}`;
    localStorage.setItem(key, storedId);
    
    // Gizli mod sorununa karşı sessionStorage'a da kaydedelim
    sessionStorage.setItem(key, storedId);
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
    // 1. Sabit donanım bilgilerini kullanalım
    const safeHardwareID = getSafeHardwareID();
    
    // 2. Hardware signature doğrudan donanım özelliklerinden oluşsun
    const hardwareSignature = await sha256(safeHardwareID);
    
    // 3. Fingerprint'i de değişkenlerden değil, hardwareSignature'dan üretelim
    // Böylece her ikisi de tutarlı olur
    const fingerprint = await sha256(hardwareSignature + navigator.userAgent);
    
    console.debug('Device Info:', {
      safeHardwareID,
      screenSize: `${screen.width}x${screen.height}`,
      platform: navigator.platform,
      hardwareSignature: hardwareSignature.substring(0, 8)
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

// 1. getSafeHardwareID fonksiyonu ekleyelim - bu donanıma odaklanıp değişmez bilgiler kullanır
const getSafeHardwareID = (): string => {
  try {
    // Mevcut özellikleri koruyalım
    const screenProps = `${screen.width}x${screen.height}x${screen.colorDepth}`;
    const pixelRatio = `${window.devicePixelRatio}`.replace('.', '_');
    const cores = navigator.hardwareConcurrency || 0;
    const platform = (navigator.platform || 'unknown').replace(/\s/g, '');
    const timezone = new Date().getTimezoneOffset();
    const language = navigator.language || '';
    
    // GPU bilgisi
    const gpuInfo = getWebGLInfo().split('|');
    const gpuVendor = (gpuInfo[0] || 'unknown').replace(/\s/g, '').toLowerCase();
    const gpuRenderer = (gpuInfo[1] || 'unknown').replace(/\s/g, '').toLowerCase();
    
    // Ek benzersizlik bilgileri ekleyelim
    const fontList = getFontList().substring(0, 100); // Yüklü fontlar benzersizlik sağlar
    const screenAvail = `${screen.availWidth}x${screen.availHeight}`; // Kullanılabilir ekran alanı
    const plugins = ('plugins' in navigator && navigator.plugins) ? 
                     navigator.plugins.length.toString() : '0'; // Plugin sayısı
    
    // Tüm özellikleri birleştir
    return [
      screenProps,
      pixelRatio,
      cores,
      platform.substring(0, 5),
      timezone,
      language.substring(0, 2),
      gpuVendor.substring(0, 10),
      gpuRenderer.substring(0, 10),
      navigator.maxTouchPoints || 0,
      screenAvail,
      plugins,
      // Güvenlik için fontList'ten bir hash kullanın (aşırı uzun olabilir)
      fontList.length.toString() + (fontList.charCodeAt(0) || 0) + (fontList.charCodeAt(fontList.length - 1) || 0)
    ].join('-').replace(/[^a-z0-9\-_]/gi, '');
    
  } catch (error) {
    console.error('Güvenli donanım ID oluşturma hatası:', error);
    return '';
  }
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
      deviceMemory: 'deviceMemory' in navigator ? (navigator as any).deviceMemory : undefined,
      maxTouchPoints: navigator.maxTouchPoints
    },
    hasLocalStorage: 'localStorage' in window,
    hasWebGL: 'WebGL2RenderingContext' in window,
    // YENİ: Ek debug bilgileri
    webGLInfo: getWebGLInfo(),
    fontList: getFontList().substring(0, 30) + '...',
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString()
  };
};