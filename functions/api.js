require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const serverless = require('serverless-http');

const app = express();
app.use(express.json());

// --- CONFIGURATION LIGNE --- (C'est elle l'adresse officielle)
const baseUrl = 'https://cataloguefbwl.netlify.app';

// Configuration des sessions via Cookies (optimisé pour le serverless)
app.use(cookieSession({
    name: 'fbwl_auth',
    secret: process.env.SESSION_SECRET || 'fallback_secret_fbwl_2026',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
    secure: true,
    sameSite: 'lax'
}));

// Petit hack pour que Passport soit content sur Netlify
app.use((req, res, next) => {
    if (req.session && !req.session.regenerate) req.session.regenerate = (cb) => cb();
    if (req.session && !req.session.save) req.session.save = (cb) => cb();
    next();
});

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: `${baseUrl}/auth/discord/callback`,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    profile.accessToken = accessToken;
    return done(null, profile);
}));

// --- CONFIGURATION TWITCH (Proxy) ---
let twitchAccessToken = '';
async function getTwitchToken() {
    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                grant_type: 'client_credentials'
            }
        });
        twitchAccessToken = response.data.access_token;
    } catch (error) {
        console.error("❌ ERREUR TOKEN TWITCH:", error.message);
    }
}

// --- ROUTES ---

app.get('/auth/discord', (req, res, next) => {
    console.log("🚀 Départ vers Discord...");
    passport.authenticate('discord', { 
        callbackURL: `${baseUrl}/auth/discord/callback` 
    })(req, res, next);
});

app.get('/auth/discord/callback', (req, res, next) => {
    console.log("📩 Retour de Discord...");
    passport.authenticate('discord', {
        callbackURL: `${baseUrl}/auth/discord/callback`,
        failureRedirect: '/'
    }, (err, user, info) => {
        if (err || !user) return res.redirect('/');
        req.login(user, () => next());
    })(req, res, next);
}, async (req, res) => {
    try {
        const guildId = process.env.DISCORD_GUILD_ID;
        const botToken = process.env.DISCORD_BOT_TOKEN;
        const userId = req.user.id;

        // On vérifie les rôles sur Discord
        const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
            headers: { Authorization: `Bot ${botToken}` }
        });

        const roles = response.data.roles || [];
        const isCitoyen = roles.includes(process.env.DISCORD_ROLE_ID_CITOYEN);
        const isStaff = roles.includes(process.env.DISCORD_ROLE_ID_STAFF);
        const targetVoiceId = process.env.DISCORD_VOICE_CHANNEL_ID;

        // On vérifie le salon vocal (Anti-Streamhack)
        let isInTargetVoice = false;
        try {
            const voiceRes = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/voice-states/${userId}`, {
                headers: { Authorization: `Bot ${botToken}` }
            }).catch(() => null);
            if (voiceRes && voiceRes.data) isInTargetVoice = voiceRes.data.channel_id === targetVoiceId;
        } catch (e) { }

        // Blocage si citoyen en vocal et pas staff
        if (isCitoyen && isInTargetVoice && !isStaff) {
            return res.redirect('/blocked.html');
        }

        // Si OK -> On envoie sur le catalogue
        return res.redirect('/Catalogue_RP/Catalogue.html');
    } catch (e) {
        // En cas d'erreur API Discord, on autorise quand même par défaut (pour ne pas bloquer tout le monde)
        return res.redirect('/Catalogue_RP/Catalogue.html');
    }
});

// --- NOUVELLES ROUTES SÉCURISÉES (PROXY API) ---

// API pour vérifier le login Admin
app.post('/api/admin/login', (req, res) => {
    const { user, pin } = req.body;
    const envUser = process.env.ADMIN_USER || 'admin';
    const envPin = process.env.ADMIN_PIN || '1234';

    console.log(`🔐 Tentative de login : User=${user}, Pin=${pin}`);
    if (user === envUser && pin === envPin) {
        console.log("✅ Login Admin réussi !");
        res.json({ success: true });
    } else {
        console.warn(`❌ Login Admin échoué : Attendu ${envUser}/${envPin} mais reçu ${user}/${pin}`);
        res.status(401).json({ success: false, message: "Identifiants incorrects" });
    }
});

// API Proxy pour Twitch status live
app.get('/api/twitch/live', async (req, res) => {
    const logins = req.query.logins ? req.query.logins.split(',') : [];
    if (logins.length === 0) return res.json({ data: [] });
    
    if (!twitchAccessToken) await getTwitchToken();

    try {
        let allLives = [];
        for (let i = 0; i < logins.length; i += 100) {
            const batch = logins.slice(i, i + 100);
            const params = batch.map(l => `user_login=${encodeURIComponent(l)}`).join('&');
            const twitchRes = await axios.get(`https://api.twitch.tv/helix/streams?${params}`, {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${twitchAccessToken}`
                }
            });
            allLives = [...allLives, ...(twitchRes.data.data || [])];
        }
        res.json({ data: allLives });
    } catch (error) {
        console.error("❌ ERREUR PROXY TWITCH:", error.message);
        res.status(500).json({ error: "Erreur Twitch API" });
    }
});

// Export pour Netlify
module.exports.handler = serverless(app);
