// utils/serverFingerprint.ts

export interface FingerprintValidationResult {
  isValid: boolean;
  error?: string;
}

export const validateFingerprint = async (
  fingerprint: string,
  hardwareSignature: string, // Yeni parametre ekledik
  studentId: string
): Promise<FingerprintValidationResult> => {
  try {
    // Fingerprint formatı kontrolü
    if (!fingerprint || fingerprint.length < 32) {
      return {
        isValid: false,
        error: 'Geçersiz fingerprint formatı'
      };
    }

    // Hardware Signature kontrolü
    if (!hardwareSignature || hardwareSignature.length < 32) {
      return {
        isValid: false,
        error: 'Geçersiz hardware signature formatı'
      };
    }

    // Karakter seti kontrolü (güvenlik için)
    const validCharPattern = /^[a-f0-9]+$/i;
    if (!validCharPattern.test(fingerprint) || !validCharPattern.test(hardwareSignature)) {
      return {
        isValid: false,
        error: 'Geçersiz karakter seti kullanılmış'
      };
    }

    // Burada daha detaylı kontroller eklenebilir
    // Örneğin: Blacklist kontrolü, zaman bazlı kontroller vs.

    return {
      isValid: true
    };
  } catch (error) {
    return {
      isValid: false,
      error: 'Fingerprint doğrulama hatası'
    };
  }
};