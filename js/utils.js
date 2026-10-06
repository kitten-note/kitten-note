/*
 * KittenNote
 * Copyright (C) 2026 Author of KittenNote
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * KittenNote - Shared utilities
 * Small, dependency-free helpers used across modules.
 */

/**
 * Escape a value for safe interpolation into HTML.
 * Returns '&lt;script&gt;' style output; never returns undefined.
 */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** True for plain objects (not null / arrays). */
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Clamp an arbitrary value into a string of at most maxLen characters.
 * Returns fallback when the value is not a string (or empty after trimming).
 */
export function clampString(value, maxLen, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const clamped = maxLen > 0 && value.length > maxLen ? value.slice(0, maxLen) : value;
    return clamped.length > 0 ? clamped : fallback;
}

/**
 * Normalize a timestamp-ish value to an ISO string.
 * Invalid values fall back to `fallback` (or now when fallback is undefined).
 */
export function safeIsoDate(value, fallback = undefined) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    if (fallback !== undefined) {
        const fb = new Date(fallback);
        return Number.isNaN(fb.getTime()) ? new Date().toISOString() : fb.toISOString();
    }
    return new Date().toISOString();
}

/** True when value parses as a valid date. */
export function isValidDate(value) {
    return !Number.isNaN(new Date(value).getTime());
}
