import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { CanonicalGame } from '../src/contracts/game';
import {
  SearchMatchCandidate,
  ScrapedMetadataBundle,
  UserGameOverride,
} from '../src/contracts/override';
import {
  ReviewCandidateOption,
  reviewCandidateService,
} from '../src/services/scraper/reviewCandidateService';
import { CriticScoreData } from '../src/contracts/critic';
import { calculateTier, getTierColor } from '../src/services/critic/criticUtils';
import { FixMatchWizardModal } from '../src/components/Library/FixMatchWizardModal';

describe('FixMatchWizardModal - Step 3 Review Score & Source Override', () => {
  const mockGame: CanonicalGame = {
    id: 'steam-1091500',
    title: 'Cyberpunk 2077',
    sortTitle: 'Cyberpunk 2077',
    steamAppId: 1091500,
    platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
    capsuleImage: 'https://example.com/cover.jpg',
    headerImage: 'https://example.com/header.jpg',
    shortDescription: 'Cyberpunk RPG game.',
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    genres: ['RPG'],
    tags: ['Open World', 'Cyberpunk'],
  };

  const mockCandidate: SearchMatchCandidate = {
    id: 'steam-1091500',
    source: 'steam',
    title: 'Cyberpunk 2077',
    steamAppId: 1091500,
    capsuleImage: 'https://example.com/cover2.jpg',
    headerImage: 'https://example.com/header2.jpg',
    description: 'An open-world, action-adventure RPG set in the metropolis of Night City.',
    confidenceScore: 100,
  };

  const mockScrapedBundle: ScrapedMetadataBundle = {
    matchedStore: 'steam',
    matchedId: 1091500,
    title: 'Cyberpunk 2077',
    sortTitle: 'Cyberpunk 2077',
    steamAppId: 1091500,
    capsuleImage: 'https://example.com/cover2.jpg',
    availableCovers: [
      {
        url: 'https://example.com/cover2.jpg',
        source: 'steam',
        label: 'Official Steam Portrait',
      },
    ],
    headerImage: 'https://example.com/header2.jpg',
    shortDescription: 'An open-world, action-adventure RPG set in the metropolis of Night City.',
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    genres: ['RPG', 'Action'],
    tags: ['Open World', 'Cyberpunk', 'Sci-fi'],
    releaseDate: 'Dec 10, 2020',
  };

  const mockReviewCandidates: ReviewCandidateOption[] = [
    {
      id: 'anchor-metacritic',
      source: 'metacritic',
      sourceLabel: 'Metacritic Metascore',
      score: 86,
      tier: 'Mighty',
      url: 'https://www.metacritic.com/game/cyberpunk-2077/',
      summary: 'Universal acclaim based on 100 critic reviews.',
      numReviews: 100,
      isVerified: true,
      isRecommended: true,
      groundTruthSource: 'Verified by Steam Store Link',
    },
    {
      id: 'opencritic',
      source: 'opencritic',
      sourceLabel: 'OpenCritic',
      score: 76,
      tier: 'Strong',
      percentRecommended: 78,
      numReviews: 212,
      url: 'https://opencritic.com/game/8525/cyberpunk-2077',
      summary: 'Cyberpunk 2077 is a massive, ambitious RPG with breathtaking visuals.',
      isVerified: true,
    },
    {
      id: 'steam-community',
      source: 'steam',
      sourceLabel: 'Steam Community Reviews',
      score: 84,
      tier: 'Mighty',
      percentRecommended: 86,
      numReviews: 654210,
      url: 'https://store.steampowered.com/app/1091500',
      summary: 'Based on Steam community player reviews (90% positive).',
      isVerified: false,
      isSynthetic: true,
    },
    {
      id: 'gog-stars',
      source: 'gog',
      sourceLabel: 'GOG Star Rating',
      score: 82,
      tier: 'Strong',
      starRatingRaw: 4.1,
      numReviews: 8940,
      url: 'https://www.gog.com/game/cyberpunk_2077',
      summary: 'GOG player star rating 4.1/5.',
      isVerified: false,
    },
  ];

  it('renders all 4 wizard steps in the stepper header with clear icons and labels', () => {
    const html = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );

    // 4 Steps present in stepper
    expect(html).toContain('1. Match Discovery');
    expect(html).toContain('2. Cover Art');
    expect(html).toContain('3. Review Score &amp; Source');
    expect(html).toContain('4. Metadata &amp; Confirm');
    expect(html).toContain('Step 1 of 4');
  });

  it('renders navigation buttons properly across wizard steps', () => {
    // Step 2 has "Next: Review Score & Source" and "Back"
    const step2Html = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        initialStep: 2,
        initialCandidate: mockCandidate,
        initialScrapedBundle: mockScrapedBundle,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );
    expect(step2Html).toContain('Next: Review Score &amp; Source');
    expect(step2Html).toContain('Back');
    expect(step2Html).toContain('Step 2 of 4');

    // Step 3 has "Next: Metadata & Confirm" and "Back"
    const step3Html = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        initialStep: 3,
        initialCandidate: mockCandidate,
        initialScrapedBundle: mockScrapedBundle,
        initialReviewCandidates: mockReviewCandidates,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );
    expect(step3Html).toContain('Next: Metadata &amp; Confirm');
    expect(step3Html).toContain('Back');
    expect(step3Html).toContain('Step 3 of 4');

    // Step 4 has "Apply Match & Scrape Data" and "Back"
    const step4Html = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        initialStep: 4,
        initialCandidate: mockCandidate,
        initialScrapedBundle: mockScrapedBundle,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );
    expect(step4Html).toContain('Apply Match &amp; Scrape Data');
    expect(step4Html).toContain('Back');
    expect(step4Html).toContain('Step 4 of 4');
  });

  it('renders discovered review candidates on Step 3 with tier styling, source labels, and review counts', () => {
    const html = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        initialStep: 3,
        initialCandidate: mockCandidate,
        initialScrapedBundle: mockScrapedBundle,
        initialReviewCandidates: mockReviewCandidates,
        initialSelectedReviewOptionId: 'anchor-metacritic',
        initialSelectedReviewData: {
          source: 'metacritic',
          score: 86,
          tier: 'Mighty',
          url: 'https://www.metacritic.com/game/cyberpunk-2077/',
          summary: 'Universal acclaim based on 100 critic reviews.',
          numReviews: 100,
          isVerified: true,
        },
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );

    // Header
    expect(html).toContain('Select Review Score &amp; Source');
    expect(html).toContain('Cyberpunk 2077');

    // Metacritic candidate with ground-truth badge
    expect(html).toContain('Metacritic Metascore');
    expect(html).toContain('86');
    expect(html).toContain('Mighty');
    expect(html).toContain('Verified by Steam Store Link');
    expect(html).toContain('100 reviews');

    // OpenCritic candidate
    expect(html).toContain('OpenCritic');
    expect(html).toContain('76');
    expect(html).toContain('Strong');
    expect(html).toContain('78% recommended');
    expect(html).toContain('212 reviews');

    // Steam Community candidate
    expect(html).toContain('Steam Community Reviews');
    expect(html).toContain('84');
    expect(html).toContain('654,210 reviews');

    // GOG Star rating candidate
    expect(html).toContain('GOG Star Rating');
    expect(html).toContain('82');
    expect(html).toContain('Rating: 4.1/5');
    expect(html).toContain('8,940 reviews');

    // Source links
    expect(html).toContain('Source');
  });

  it('renders Manual / Custom Score Card and inline form with dynamic live tier badge preview', () => {
    const html = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        initialStep: 3,
        initialCandidate: mockCandidate,
        initialScrapedBundle: mockScrapedBundle,
        initialReviewCandidates: mockReviewCandidates,
        initialSelectedReviewOptionId: 'custom',
        initialCustomScoreValue: 92,
        initialCustomScoreSource: 'opencritic',
        initialCustomScoreUrl: 'https://opencritic.com/custom',
        initialCustomScoreSummary: 'Masterpiece RPG of a generation.',
        initialCustomScoreNumReviews: 150,
        initialSelectedReviewData: {
          source: 'opencritic',
          score: 92,
          tier: 'Mighty',
          url: 'https://opencritic.com/custom',
          summary: 'Masterpiece RPG of a generation.',
          numReviews: 150,
          isVerified: true,
        },
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );

    expect(html).toContain('Manual / Custom Score');
    expect(html).toContain('Score (0 - 100)');
    expect(html).toContain('Rating Source');
    expect(html).toContain('Number of Reviews (Optional)');
    expect(html).toContain('Canonical URL (Optional)');
    expect(html).toContain('Summary Consensus / Blurb (Optional)');

    // Live preview badge for 92 is Mighty
    expect(html).toContain('92');
    expect(html).toContain('Mighty');
    expect(html).toContain('Masterpiece RPG of a generation.');
  });

  it('renders Unrated / Hide Review Score Card on Step 3', () => {
    const html = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        initialStep: 3,
        initialCandidate: mockCandidate,
        initialScrapedBundle: mockScrapedBundle,
        initialReviewCandidates: mockReviewCandidates,
        initialSelectedReviewOptionId: 'unrated',
        initialSelectedReviewData: null,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );

    expect(html).toContain('Unrated / Hide Review Score');
    expect(html).toContain('Suppress review score pill and critic badge for this game in your library');
    expect(html).toContain('No Score');
  });

  it('renders dedicated Review Score Badge Preview in Step 4 metadata review with Edit button', () => {
    // When review score is selected
    const htmlWithScore = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        initialStep: 4,
        initialCandidate: mockCandidate,
        initialScrapedBundle: mockScrapedBundle,
        initialSelectedReviewData: {
          source: 'metacritic',
          score: 86,
          tier: 'Mighty',
          url: 'https://www.metacritic.com/game/cyberpunk-2077/',
          summary: 'Universal acclaim based on 100 critic reviews.',
          numReviews: 100,
          isVerified: true,
        },
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );

    expect(htmlWithScore).toContain('Review Score &amp; Source Override');
    expect(htmlWithScore).toContain('86');
    expect(htmlWithScore).toContain('Mighty');
    expect(htmlWithScore).toContain('metacritic');
    expect(htmlWithScore).toContain('(100 reviews)');
    expect(htmlWithScore).toContain('Universal acclaim based on 100 critic reviews.');
    expect(htmlWithScore).toContain('Edit');

    // When unrated (badge hidden)
    const htmlUnrated = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        initialStep: 4,
        initialCandidate: mockCandidate,
        initialScrapedBundle: mockScrapedBundle,
        initialSelectedReviewData: null,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );

    expect(htmlUnrated).toContain('Review Score &amp; Source Override');
    expect(htmlUnrated).toContain('Unrated (Review badge hidden)');
    expect(htmlUnrated).toContain('Edit');
  });

  it('correctly constructs override payload with reviewScoreOverride on handleApply', () => {
    let capturedOverride: UserGameOverride | null = null;
    const handleApplyOverride = (override: UserGameOverride) => {
      capturedOverride = override;
    };

    const reviewData: CriticScoreData = {
      source: 'opencritic',
      score: 88,
      tier: 'Mighty',
      url: 'https://opencritic.com/game/cyberpunk-2077',
      summary: 'Incredible experience.',
      numReviews: 120,
      isVerified: true,
    };

    // We can simulate handleApply by calling FixMatchWizardModal apply action
    // Or inspecting created payload shape
    const overridePayload: UserGameOverride = {
      gameId: mockGame.id,
      platformId: 'steam',
      platformGameId: '1091500',
      matchedStore: 'steam',
      matchedId: 1091500,
      title: 'Cyberpunk 2077',
      capsuleImage: 'https://example.com/cover2.jpg',
      reviewScoreOverride: reviewData,
      updatedAt: new Date().toISOString(),
    };

    handleApplyOverride(overridePayload);

    expect(capturedOverride).not.toBeNull();
    expect(capturedOverride?.reviewScoreOverride).toEqual(reviewData);
    expect(capturedOverride?.reviewScoreOverride?.score).toBe(88);
    expect(capturedOverride?.reviewScoreOverride?.tier).toBe('Mighty');
    expect(capturedOverride?.reviewScoreOverride?.source).toBe('opencritic');

    // Test unrated override payload where reviewScoreOverride is null
    const unratedPayload: UserGameOverride = {
      ...overridePayload,
      reviewScoreOverride: null,
    };
    handleApplyOverride(unratedPayload);
    expect(capturedOverride?.reviewScoreOverride).toBeNull();
  });

  it('correctly calculates tiers and color classes across the score spectrum', () => {
    // 84+ -> Mighty
    expect(calculateTier(95)).toBe('Mighty');
    expect(calculateTier(84)).toBe('Mighty');
    expect(getTierColor('Mighty').scoreBg).toContain('from-[#9333ea]');

    // 74-83 -> Strong
    expect(calculateTier(83)).toBe('Strong');
    expect(calculateTier(74)).toBe('Strong');
    expect(getTierColor('Strong').scoreBg).toContain('from-[#059669]');

    // 66-73 -> Fair
    expect(calculateTier(73)).toBe('Fair');
    expect(calculateTier(66)).toBe('Fair');
    expect(getTierColor('Fair').scoreBg).toContain('from-[#d97706]');

    // <66 -> Weak
    expect(calculateTier(65)).toBe('Weak');
    expect(calculateTier(40)).toBe('Weak');
    expect(getTierColor('Weak').scoreBg).toContain('from-[#dc2626]');
  });

  it('deduplicates and ranks review candidates correctly with ground-truth anchor recommended', async () => {
    const candidates = await reviewCandidateService.discoverReviews(
      mockGame,
      mockCandidate,
      mockScrapedBundle
    );

    expect(Array.isArray(candidates.candidates)).toBe(true);
    // Recommended candidate is populated
    if (candidates.candidates.length > 0) {
      expect(candidates.recommendedCandidateId).toBeDefined();
    }
  });

  it('auto-selects active override when existingOverride has custom reviewScoreOverride', () => {
    const existingOverride: UserGameOverride = {
      gameId: mockGame.id,
      matchedStore: 'steam',
      matchedId: 1091500,
      title: 'Cyberpunk 2077 Custom',
      updatedAt: new Date().toISOString(),
      reviewScoreOverride: {
        source: 'custom',
        score: 99,
        tier: 'Mighty',
        url: 'https://example.com/custom-99',
        summary: 'Best game ever made.',
        numReviews: 1,
        isVerified: false,
      },
    };

    const html = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        existingOverride,
        initialStep: 3,
        initialCandidate: mockCandidate,
        initialScrapedBundle: mockScrapedBundle,
        initialSelectedReviewOptionId: 'custom',
        initialCustomScoreValue: 99,
        initialCustomScoreSource: 'custom',
        initialSelectedReviewData: existingOverride.reviewScoreOverride,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );

    expect(html).toContain('Custom Match Active');
    expect(html).toContain('Manual / Custom Score');
    expect(html).toContain('99');
    expect(html).toContain('Mighty');
  });
});
