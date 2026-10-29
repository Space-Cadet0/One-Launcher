import { describe, expect, it } from 'vitest';
import { storefrontReviewHarvester } from '../../src/services/critic/storefrontReviewHarvester';

describe('Opt-In Live Storefront Smoke Suite', () => {
  it('reaches live Steam appdetails API for Half-Life 2 (AppID 220)', async () => {
    const anchor = await storefrontReviewHarvester.getSteamAnchor(220);
    expect(anchor).not.toBeNull();
    expect(anchor?.storefront).toBe('steam');
    expect(anchor?.isVerifiedGroundTruth).toBe(true);
  });
});
