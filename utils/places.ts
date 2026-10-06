// utils/places.ts (yalnızca sunucuda kullanılır)
//
// Yoklama alınabilecek konumlar. Okul koordinatları kodda; ev koordinatları
// herkese açık repoya girmesin diye HOME_LOCATION ortam değişkeninden okunur
// (örnek: HOME_LOCATION="41.0000000,29.0000000").
//
// "Ev" konumu yalnızca TEACHER_PASSWORD gizli bir değerle ayarlıyken açılır:
// ev konumu sadece imzalı (öğretmenin ürettiği) QR ile sorgulanabildiği için,
// imza anahtarı herkesçe bilinen eski şifre olursa biri farklı koordinatlar
// deneyerek ev konumunu bulabilirdi.

import { STATIC_CLASS_LOCATION } from '@/config/constants';
import { isTeacherPasswordConfigured } from '@/utils/teacherAuth';
import type { PlaceCode } from '@/utils/qrFormat';

export const MAX_DISTANCE_KM = 0.8;

export interface Place {
  code: PlaceCode;
  name: string;
  lat: number;
  lng: number;
}

function parseCoordinates(value: string | undefined): { lat: number; lng: number } | null {
  if (!value) return null;
  const parts = value.split(',').map(part => Number(part.trim()));
  if (parts.length !== 2 || parts.some(n => !Number.isFinite(n))) return null;
  const [lat, lng] = parts;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function getPlaces(): Place[] {
  const places: Place[] = [
    { code: 'O', name: 'Okul', lat: STATIC_CLASS_LOCATION.lat, lng: STATIC_CLASS_LOCATION.lng }
  ];
  const home = parseCoordinates(process.env.HOME_LOCATION);
  if (home && isTeacherPasswordConfigured()) {
    places.push({ code: 'E', name: 'Ev', ...home });
  }
  return places;
}

export function getPlace(code: string | undefined): Place | null {
  return getPlaces().find(place => place.code === code) || null;
}

// İki koordinat arasındaki mesafe (km)
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}
