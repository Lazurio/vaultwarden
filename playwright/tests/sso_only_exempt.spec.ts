import { test, expect, type APIRequestContext, type APIResponse, type Page, type TestInfo } from '@playwright/test';
import { pbkdf2Sync, randomUUID } from 'node:crypto';

import * as utils from '../global-utils';
import { logNewUser, logUser } from './setups/sso';

let users = utils.loadEnv();

// user3 stands in for a technical account (automation, `bw` CLI, browser extension)
const technical = users.user3;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const vaultEnv = {
    SSO_ENABLED: true,
    SSO_ONLY: true,
    SSO_ONLY_EXEMPT_EMAILS: `${escapeRegex(technical.email)}|svc-[a-z0-9-]+@example\\.com`,
    SSO_ONLY_API_KEY: true,
};

// The server stores keys as given; these checks only exercise its login and account decisions
const placeholderKey = '2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

test.beforeAll('Setup', async ({ browser }, testInfo: TestInfo) => {
    await utils.startVault(browser, testInfo, vaultEnv);
});

test.afterAll('Teardown', async ({}) => {
    utils.stopVault();
});

// The master password hash a Bitwarden client sends for a PBKDF2 account
function masterPasswordHash(email: string, password: string, iterations: number): string {
    const masterKey = pbkdf2Sync(password, email.trim().toLowerCase(), iterations, 32, 'sha256');
    return pbkdf2Sync(masterKey, password, 1, 32, 'sha256').toString('base64');
}

async function token(request: APIRequestContext, form: Record<string, string>) {
    return request.post('/identity/connect/token', {
        form: { ...form, deviceType: '8', deviceIdentifier: randomUUID(), deviceName: 'playwright' },
    });
}

async function apiKeyLogin(request: APIRequestContext, accessToken: string, hash: string) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const apiKey = await request.post('/api/accounts/api-key', { data: { masterPasswordHash: hash }, headers });
    expect(apiKey.status()).toBe(200);
    const profile = await request.get('/api/accounts/profile', { headers });
    expect(profile.status()).toBe(200);

    return token(request, {
        grant_type: 'client_credentials',
        scope: 'api',
        client_id: `user.${(await profile.json()).id}`,
        client_secret: (await apiKey.json()).apiKey,
    });
}

// Signs a person in through SSO in the browser; returns the web vault's bearer header and the master password hash
async function personSession(
    page: Page,
    request: APIRequestContext,
    user: { email: string; name: string; password: string },
    options: { newUser?: boolean } = {}
) {
    let accessToken: string | undefined;
    page.on('response', async (response) => {
        if (response.url().endsWith('/identity/connect/token') && response.ok()) {
            const body = await response.json().catch(() => undefined);
            accessToken = body?.access_token ?? accessToken;
        }
    });
    if (options.newUser) {
        await logNewUser(test, page, user);
    } else {
        await logUser(test, page, user);
    }
    expect(accessToken).toBeDefined();

    const prelogin = await request.post('/identity/accounts/prelogin', { data: { email: user.email } });
    const kdf = await prelogin.json();
    expect(kdf.kdf).toBe(0);
    return {
        headers: { Authorization: `Bearer ${accessToken}` },
        hash: masterPasswordHash(user.email, user.password, kdf.kdfIterations),
    };
}

async function expectNotEligible(response: Promise<APIResponse>) {
    const result = await response;
    expect(result.status()).toBe(400);
    expect(await result.text()).toContain('Email address not eligible for invitations');
}

test('Technical account keeps the master password login', async ({ request }) => {
    const hash = masterPasswordHash(technical.email, technical.password, 100_000);

    await test.step('Register with email and master password', async () => {
        const verification = await request.post('/identity/accounts/register/send-verification-email', {
            data: { email: technical.email, name: technical.name },
            headers: { Accept: 'application/json' },
        });
        expect(verification.status()).toBe(200);

        const finish = await request.post('/identity/accounts/register/finish', {
            data: {
                email: technical.email,
                emailVerificationToken: await verification.json(),
                kdf: 0,
                kdfIterations: 100_000,
                masterPasswordHash: hash,
                key: placeholderKey,
            },
        });
        expect(finish.status()).toBe(200);
    });

    await test.step('Password grant, refresh and API key', async () => {
        const login = await token(request, {
            grant_type: 'password',
            username: technical.email,
            password: hash,
            scope: 'api offline_access',
            client_id: 'cli',
        });
        expect(login.status()).toBe(200);
        const session = await login.json();

        const refresh = await request.post('/identity/connect/token', {
            form: { grant_type: 'refresh_token', refresh_token: session.refresh_token, client_id: 'cli' },
        });
        expect(refresh.status()).toBe(200);

        // `SSO_ONLY_API_KEY` leaves the API key of a technical account working
        const keyLogin = await apiKeyLogin(request, session.access_token, hash);
        expect(keyLogin.status()).toBe(200);
    });
});

test('Other addresses cannot register or use the master password', async ({ request }) => {
    const verification = await request.post('/identity/accounts/register/send-verification-email', {
        data: { email: users.user2.email, name: users.user2.name },
    });
    expect(verification.status()).toBe(400);
    expect(await verification.text()).toContain('Registration not allowed or user already exists');

    const login = await token(request, {
        grant_type: 'password',
        username: users.user2.email,
        password: masterPasswordHash(users.user2.email, users.user2.password, 100_000),
        scope: 'api offline_access',
        client_id: 'cli',
    });
    expect(login.status()).toBe(400);
    expect(await login.text()).toContain('SSO sign-in is required');
});

test('SSO cannot sign in to a technical account', async ({ page }) => {
    await utils.cleanLanding(page);
    await page.locator("input[type=email].vw-email-sso").fill(technical.email);

    const exchange = page.waitForResponse(
        (response) => response.url().endsWith('/identity/connect/token') && response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /Use single sign-on/ }).click();

    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
    await page.getByLabel(/Username/).fill(technical.name);
    await page.getByLabel('Password', { exact: true }).fill(technical.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    const response = await exchange;
    expect(response.status()).toBe(400);
    expect(await response.text()).toContain('SSO sign-in is not available for this account');
});

test('A person can neither log in with an API key nor move to a technical address', async ({ page, request }) => {
    const { headers, hash } = await personSession(page, request, users.user1, { newUser: true });

    await test.step('API key login is refused with SSO_ONLY_API_KEY', async () => {
        const keyLogin = await apiKeyLogin(request, headers.Authorization.slice('Bearer '.length), hash);
        expect(keyLogin.status()).toBe(400);
        expect(await keyLogin.text()).toContain('SSO sign-in is required');
    });

    await test.step('Email change to a technical address is refused', async () => {
        const rename = await request.post('/api/accounts/email-token', {
            data: { masterPasswordHash: hash, newEmail: 'svc-renamed@example.com' },
            headers,
        });
        expect(rename.status()).toBe(400);
        expect(await rename.text()).toContain('Email address not allowed');
    });
});

test('A pending email change cannot complete once its address becomes exempt', async ({ page, request }) => {
    const { headers, hash } = await personSession(page, request, users.user1);
    const later = 'later@example.org';

    const pending = await request.post('/api/accounts/email-token', { data: { masterPasswordHash: hash, newEmail: later }, headers });
    expect(pending.status()).toBe(200);

    // The admin adds the address to the exemption in the admin panel while the change is pending.
    // (A restart with another environment would recreate this suite's container, which keeps no data.)
    expect((await request.post('/admin', { form: { token: process.env.ADMIN_TOKEN! } })).ok()).toBe(true);
    const extended = await request.post('/admin/config', {
        data: { sso_only_exempt_emails: `${vaultEnv.SSO_ONLY_EXEMPT_EMAILS}|${escapeRegex(later)}` },
    });
    expect(extended.status()).toBe(200);

    // Without SMTP the final step checks no token, so only the second exemption check refuses it
    const finish = await request.post('/api/accounts/email', {
        data: { masterPasswordHash: hash, newMasterPasswordHash: hash, newEmail: later, token: '0', key: placeholderKey },
        headers,
    });
    expect(finish.status()).toBe(400);
    expect(await finish.text()).toContain('Email address not allowed');

    const profile = await request.get('/api/accounts/profile', { headers });
    expect((await profile.json()).email).toBe(users.user1.email.toLowerCase());

    // Back to this file's configuration
    expect((await request.post('/admin/config/delete', { data: {} })).status()).toBe(200);
});

test('Organizations and emergency access cannot create an exempt account', async ({ page, request }) => {
    const { headers, hash } = await personSession(page, request, users.user1);

    const created = await request.post('/api/organizations', {
        data: {
            name: 'Exempt addresses',
            billingEmail: users.user1.email,
            collectionName: placeholderKey,
            key: placeholderKey,
            keys: { publicKey: 'AAAA', encryptedPrivateKey: placeholderKey },
            planType: 0,
        },
        headers,
    });
    expect(created.status()).toBe(200);
    const orgId = (await created.json()).id;

    await test.step('Organization invitation', async () => {
        const invite = (email: string) =>
            request.post(`/api/organizations/${orgId}/users/invite`, { data: { emails: [email], groups: [], type: 2, collections: [] }, headers });
        await expectNotEligible(invite('svc-invited@example.com'));
        // An existing technical account can still be invited
        expect((await invite(technical.email)).status()).toBe(200);
    });

    await test.step('Emergency access invitation', async () => {
        await expectNotEligible(request.post('/api/emergency-access/invite', { data: { email: 'svc-grantee@example.com', type: 0, waitTimeDays: 7 }, headers }));
    });

    await test.step('Directory Connector import', async () => {
        const apiKey = await request.post(`/api/organizations/${orgId}/api-key`, { data: { masterPasswordHash: hash }, headers });
        expect(apiKey.status()).toBe(200);
        const orgLogin = await request.post('/identity/connect/token', {
            form: { grant_type: 'client_credentials', scope: 'api.organization', client_id: `organization.${orgId}`, client_secret: (await apiKey.json()).apiKey },
        });
        expect(orgLogin.status()).toBe(200);
        await expectNotEligible(request.post('/api/public/organization/import', {
            data: { groups: [], members: [{ email: 'svc-imported@example.com', externalId: 'svc-imported', deleted: false }], overwriteExisting: false, largeImport: false },
            headers: { Authorization: `Bearer ${(await orgLogin.json()).access_token}` },
        }));
    });
});
