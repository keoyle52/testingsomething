import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safely extract an error message from an unknown error value.
 * Handles Axios-style error shapes and standard Error objects.
 */
export function getErrorMessage(err: unknown, fallback = 'Bilinmeyen hata'): string {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const response = e.response as Record<string, unknown> | undefined;
    const data = response?.data as Record<string, unknown> | undefined;
    if (typeof data?.message === 'string') return data.message;
    if (typeof e.message === 'string') return e.message;
  }
  return fallback;
}
