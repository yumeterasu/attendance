import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

type Player = ReturnType<typeof createAudioPlayer>;

// Created lazily on first use (inside configureCheckinAudio), never at module
// load time -- creating a native audio player as soon as this file is
// imported (before React Native's bridge is fully up) could throw and crash
// the whole app before any screen even renders. Deferring + wrapping in
// try/catch means a sound-init failure costs the chime, never the app.
let checkinPlayer: Player | null = null;
let checkoutPlayer: Player | null = null;
let audioConfigured = false;

// Lets the confirmation chime play even when the tablet's ringer switch is
// silenced (media volume still applies -- the kiosk tablet needs its volume
// up either way). Call once when the kiosk screen mounts.
export async function configureCheckinAudio(): Promise<void> {
  if (audioConfigured) return;
  audioConfigured = true;

  try {
    await setAudioModeAsync({ playsInSilentMode: true });
  } catch {
    // non-fatal -- worst case the chime just won't play under silent mode
  }

  try {
    checkinPlayer = createAudioPlayer(require('../../assets/sounds/checkin.wav'));
    checkoutPlayer = createAudioPlayer(require('../../assets/sounds/checkout.wav'));
  } catch {
    // a sound-init failure must never take down the app -- just no chime
  }
}

async function play(player: Player | null): Promise<void> {
  if (!player) return;
  try {
    await player.seekTo(0); // rewind so a second tap re-plays from the start, not from where it ended
    player.play();
  } catch {
    // a sound glitch must never interrupt the actual check-in
  }
}

export function playCheckinSound(): void {
  play(checkinPlayer);
}

export function playCheckoutSound(): void {
  play(checkoutPlayer);
}
