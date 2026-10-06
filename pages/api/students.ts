// pages/api/students.ts
import { NextApiRequest, NextApiResponse } from 'next';
import { getMainRows } from '@/utils/sheets';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Sadece GET isteklerine izin ver
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Yoklama ile aynı önbelleği paylaşır; sınıf aynı anda sayfayı açtığında
    // her öğrenci için ayrı Sheets okuması yapılmaz
    const rows = await getMainRows({ maxAgeMs: 60000 });

    // Başlık satırını atla, sadece öğrenci verilerini dön (B: numara, C: ad)
    const students = rows.slice(1).map((row) => ({
      studentId: row[1]?.toString().trim() || '',
      studentName: row[2]?.toString() || ''
    }));

    // Cache header'ı ekle (60 saniye)
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');

    return res.status(200).json({ students });
  } catch (error) {
    console.error('Öğrenci listesi alma hatası:', error);
    return res.status(500).json({ error: 'Öğrenci listesi alınamadı' });
  }
}
