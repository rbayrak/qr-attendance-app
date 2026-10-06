// pages/api/teacher-login.ts
// Öğretmen şifresini sunucuda doğrular (şifre artık tarayıcı kodunda yok).

import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyTeacherPassword } from '@/utils/teacherAuth';

// Şifre denemesine karşı örnek başına basit sınır
const MAX_FAILURES_PER_WINDOW = 10;
const WINDOW_MS = 60 * 1000;
const recentFailures: number[] = [];

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const now = Date.now();
  while (recentFailures.length && now - recentFailures[0] > WINDOW_MS) recentFailures.shift();
  if (recentFailures.length >= MAX_FAILURES_PER_WINDOW) {
    return res.status(429).json({ error: 'Çok fazla hatalı deneme. Bir dakika sonra tekrar deneyin.' });
  }

  if (!verifyTeacherPassword(req.body?.password)) {
    recentFailures.push(now);
    return res.status(401).json({ error: 'Yanlış şifre' });
  }

  return res.status(200).json({ success: true });
}
