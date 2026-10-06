// pages/api/check-location.ts
// "Konumu Doğrula" butonu: öğrencinin okul konumunda olup olmadığını söyler.
// Yalnızca okul konumu kontrol edilir; ev konumu burada asla sorgulanmaz
// (aksi halde farklı koordinatlar denenerek ev konumu bulunabilirdi).
// Asıl konum kontrolü yoklama kaydında, QR'daki konuma göre sunucuda yapılır.
// Ayrıca tarayıcının cihaz kimliği çerezi burada oluşturulur.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getPlace, distanceKm, isValidCoordinate, MAX_DISTANCE_KM } from '@/utils/places';
import { getDeviceIdentity } from '@/utils/deviceGuard';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { lat, lng } = req.body || {};
  if (!isValidCoordinate(lat, lng)) {
    return res.status(400).json({ error: 'Geçersiz konum bilgisi' });
  }

  getDeviceIdentity(req, res);
  res.setHeader('Cache-Control', 'no-store');

  const school = getPlace('O');
  if (!school) {
    return res.status(500).json({ error: 'Okul konumu tanımlı değil' });
  }
  const distance = distanceKm(lat, lng, school.lat, school.lng);

  return res.status(200).json({
    atSchool: distance <= MAX_DISTANCE_KM,
    distanceToSchoolM: Math.round(distance * 1000)
  });
}
