// utils/studentId.ts (sunucu ve istemci ortak)
//
// Öğrenci numarası eşleştirme. Numaraların çoğu yalnızca rakamdır ama bazıları
// harf içerebilir (ör. "Ç23051608"). Öğrenci küçük "ç" yazabilir ya da
// klavyesinde "Ç" olmayabilir ("C" yazar); bu durumlar da eşleşsin diye
// karşılaştırma büyük harfe çevrilip Türkçe harfler sadeleştirilerek yapılır.
// Eşleşme bulunduğunda her yerde (hücre, kayıt sayfası, cihaz eşleşmesi)
// tablodaki asıl yazım kullanılır.

const TURKISH_FOLD: Record<string, string> = {
  'Ç': 'C', 'Ğ': 'G', 'İ': 'I', 'Ö': 'O', 'Ş': 'S', 'Ü': 'U'
};

/** Karşılaştırma anahtarı: boşluklar atılır, büyük harf, Türkçe harfler sadeleşir. */
export function studentIdKey(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\s+/g, '')
    .toLocaleUpperCase('tr-TR')
    .replace(/[ÇĞİÖŞÜ]/g, ch => TURKISH_FOLD[ch]);
}

/**
 * Girilen numaraya karşılık gelen listedeki numarayı döndürür (yoksa null).
 * Önce birebir yazım aranır; yoksa sadeleştirilmiş karşılaştırma yapılır ve
 * yalnızca tek bir öğrenciye uyuyorsa kabul edilir.
 */
export function matchStudentId(input: string, ids: readonly string[]): string | null {
  const trimmed = input.normalize('NFC').trim();
  if (!trimmed) return null;
  const exact = ids.find(id => id === trimmed);
  if (exact !== undefined) return exact;
  const key = studentIdKey(trimmed);
  const matches = ids.filter(id => id && studentIdKey(id) === key);
  return matches.length === 1 ? matches[0] : null;
}
