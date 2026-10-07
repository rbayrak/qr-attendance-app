// pages/api/diagnostics.ts
// Öğrenci tarafında kamera açılamadığında ya da konum alınamadığında hatanın
// nedenini "Yoklama Kayıtları" sayfasına yazar. Böylece sorunun tarayıcı
// izninden mi, uygulama içi tarayıcıdan mı (Instagram vb.) yoksa uygulamadan mı
// kaynaklandığı görülebilir. Bu satırlar cihaz kurallarında kullanılmaz.

import type { NextApiRequest, NextApiResponse } from 'next';
import { appendLogRow } from '@/utils/sheets';
import { buildLogRow, getClientIP, getDeviceIdentity, RESULT } from '@/utils/deviceGuard';

// Kötüye kullanıma karşı örnek başına basit sınır
const MAX_REPORTS_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60 * 1000;
const recentReports: number[] = [];

const clip = (value: unknown, max: number) => String(value ?? '').replace(/\s+/g, ' ').slice(0, max);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const now = Date.now();
  while (recentReports.length && now - recentReports[0] > WINDOW_MS) recentReports.shift();
  if (recentReports.length >= MAX_REPORTS_PER_WINDOW) {
    return res.status(429).json({ error: 'Çok fazla rapor' });
  }
  recentReports.push(now);

  const body = req.body || {};
  const isLocation = body.kind === 'location';
  const studentId = clip(body.studentId, 20);
  const error = clip(body.error, 160);
  const browser = clip(body.browser, 60);
  const userAgent = clip(req.headers['user-agent'], 200);
  const note = `${error} | ${browser}${body.inAppBrowser ? ' (uygulama içi tarayıcı)' : ''} | ${userAgent}`;

  console.warn(`${isLocation ? 'Konum' : 'Kamera'} hatası: öğrenci=${studentId} ${note}`);

  try {
    const device = getDeviceIdentity(req, res);
    await appendLogRow(buildLogRow({
      now,
      week: '',
      studentId,
      name: '',
      result: isLocation ? RESULT.locationError : RESULT.cameraError,
      deviceId: device.id,
      model: clip(body.hardwareSignature, 8),
      ip: getClientIP(req),
      note
    }));
  } catch (writeError) {
    console.error('Hata kaydı yazılamadı:', writeError);
  }

  return res.status(200).json({ success: true });
}
