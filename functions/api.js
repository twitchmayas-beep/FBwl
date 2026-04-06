require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const serverless = require('serverless-http');

const app = express();

// --- CONFIGURATION LIGNE --- (C'est elle l'adresse officielle)
const baseUrl = 'https://cataloguefbwl.netlify.app';

// Configuration des sessions via Cookies (optimisé pour le serverless)
app.use(cookieSession({
    name: 'fbwl_auth',
    secret: 'anti_streamhack_fbwl_ultra_secret_2026',
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

// On force la stratégie Discord pour Netlify
passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: `${baseUrl}/auth/discord/callback`,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    profile.accessToken = accessToken;
    return done(null, profile);
}));

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

// Export pour Netlify
module.exports.handler = serverless(app);
