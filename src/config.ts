import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  lastfmApiKey: required('LASTFM_API_KEY'),
  port: parseInt(optional('PORT', '3000'), 10),
  publicUrl: optional('PUBLIC_URL', 'http://localhost:3000'),
} as const;
