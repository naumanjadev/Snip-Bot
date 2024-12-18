// src/models/userSettings.ts
import mongoose, { Schema, Document } from 'mongoose';

export interface IUserSettings extends Document {
  userId: number;
  liquidityThreshold: number | null; // In SOL
  requireMintAuthority: boolean | null; // true, false, or null (no preference)
  topHoldersThreshold: number | null; // Percentage (0-100)
  Autobuy: boolean | null; // true, false, or null (no preference)
}

const UserSettingsSchema: Schema = new Schema({
  userId: { type: Number, required: true, unique: true },
  liquidityThreshold: { type: Number, default: null },
  requireMintAuthority: { type: Boolean, default: null },
  topHoldersThreshold: { type: Number, default: null },
  Autobuy: { type: Boolean, default: null },
});

export const UserSettings = mongoose.model<IUserSettings>('UserSettings', UserSettingsSchema);
