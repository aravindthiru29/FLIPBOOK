import wave
import math
import struct
import os
import random

def create_page_turn_sound(filename, duration=0.2):
    """
    Create a quick page turn sound effect with no delay.
    Args:
        filename: Output WAV file path
        duration: Duration of the sound in seconds (default 0.2s)
    """
    sample_rate = 44100  # 44.1 kHz sample rate
    num_samples = int(sample_rate * duration)    
    # Create sound data
    frames = []
    # Seed random for consistent sound
    random.seed(42)

    for i in range(num_samples):
        t = i / sample_rate
        # Quick snap sound - paper flick
        envelope = math.exp(-8 * t / duration)
        # Primary crackle - high frequency transient (immediate attack)
        freq1 = 5000 + 3000 * math.sin(2 * math.pi * 25 * t)
        phase1 = 2 * math.pi * freq1 * t
        crackle = math.sin(phase1) * 0.4
        # Secondary whoosh - mid frequency sweep
        freq2 = 2000 - 1500 * (t / duration)  # Frequency sweep down
        phase2 = 2 * math.pi * freq2 * t
        whoosh = math.sin(phase2) * 0.3
        # White noise component
        white_noise = random.uniform(-0.8, 0.8)
        # Combine with heavy emphasis on noise for realistic paper sound
        sample = (crackle * 0.3 + whoosh * 0.2 + white_noise * 0.5) * envelope
        # Clamp to [-1, 1] range
        sample = max(-1, min(1, sample))
        # Convert to 16-bit integer
        amplitude = 32767
        sample_int = int(sample * amplitude)
        # Pack as 2-byte little-endian signed integer
        frames.append(struct.pack('<h', sample_int))
    # Write WAV file
    with wave.open(filename, 'w') as wav_file:
        # 1 channel (mono), 2 bytes per sample, sample rate
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b''.join(frames))
    print(f"Created page turn sound: {filename}")
    print(f"  Duration: {duration}s, Sample rate: {sample_rate} Hz")

if __name__ == '__main__':
    # Create the sounds directory if it doesn't exist
    sounds_dir = os.path.join('static', 'sounds')
    os.makedirs(sounds_dir, exist_ok=True)
    # Generate the sound
    output_file = os.path.join(sounds_dir, 'page-turn.wav')
    create_page_turn_sound(output_file)
    print(f"\nSound file saved to: {output_file}")
    print("The flipbook will now play this sound when pages are turned!")
