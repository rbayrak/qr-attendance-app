// utils/teacherAuth.ts (yalnızca sunucuda kullanılır)
//
// Öğretmen şifresi artık tarayıcı kodunda değil, sunucuda TEACHER_PASSWORD
// ortam değişkeninde durur. Tanımlı değilse eski şifre ("teacher123") geçerli
// kalır ki öğretmen panele girebilsin; ancak bu şifre herkese açık repoda
// yazılı olduğu için "Ev" konumu yalnızca TEACHER_PASSWORD tanımlıyken açılır.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createHmac, timingSafeEqual } from 'crypto';
import { PlaceCode, QrPayload, signingMessage, signatureFromDigest } from '@/utils/qrFormat';

const LEGACY_PASSWORD = 'teacher123';

export function getTeacherPassword(): string {
  return process.env.TEACHER_PASSWORD || LEGACY_PASSWORD;
}

/** Öğretmen şifresi gizli bir değerle ayarlanmış mı? (herkese açık eski şifre değil) */
export function isTeacherPasswordConfigured(): boolean {
  const configured = process.env.TEACHER_PASSWORD;
  return !!configured && configured !== LEGACY_PASSWORD;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyTeacherPassword(input: unknown): boolean {
  return typeof input === 'string' && safeEqual(input, getTeacherPassword());
}

/** Öğretmene özel API'ler: "Authorization: Bearer <şifre>" başlığı gerekir. */
export function requireTeacher(req: NextApiRequest, res: NextApiResponse): boolean {
  const header = req.headers.authorization || '';
  const password = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (verifyTeacherPassword(password)) return true;
  res.status(401).json({ error: 'Öğretmen girişi gerekli' });
  return false;
}

export function qrSignature(week: number, expiresAtSec: number, place: PlaceCode): string {
  const digest = createHmac('sha256', getTeacherPassword())
    .update(signingMessage(week, expiresAtSec, place))
    .digest();
  return signatureFromDigest(new Uint8Array(digest));
}

export function isQrSignatureValid(qr: QrPayload): boolean {
  return safeEqual(qr.signature, qrSignature(qr.week, qr.expiresAtSec, qr.place));
}
