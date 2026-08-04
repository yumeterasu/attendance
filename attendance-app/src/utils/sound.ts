import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

type Player = ReturnType<typeof createAudioPlayer>;

// Preloaded once at import so playback is instant on tap -- check-in should
// feel immediate. Ascending chime for IN, descending for OUT.
const checkinPlayer: Player = createAudioPlayer(require('../../assets/sounds/checkin.wav'));
const checkoutPlayer: Player = createAudioPlayer(require('../../assets/sounds/checkout.wav'));

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
}

async function play(player: Player): Promise<void> {
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
