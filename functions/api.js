require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const path = require('path');
const serverless = require('serverless-http');

const app = express();

// Configuration des sessions via Cookies (Version ultra-compatible Netlify)
app.use(cookieSession({
    name: 'fbwl_auth',
    secret: 'anti_streamhack_flashback_tv_ultra_secret_key_2024', // Un secret long et stable
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
    secure: true,
    sameSite: 'lax'
}));

// Patch pour compatibilité cookie-session et Passport (évite l'erreur regenerate)
app.use((req, res, next) => {
    if (req.session && !req.session.regenerate) {
        req.session.regenerate = (cb) => cb();
    }
    if (req.session && !req.session.save) {
        req.session.save = (cb) => cb();
    }
    next();
});

app.use(passport.initialize());
app.use(passport.session());

// Passport setup
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

const clientID = process.env.DISCORD_CLIENT_ID;
const clientSecret = process.env.DISCORD_CLIENT_SECRET;

if (clientID && clientSecret) {
    passport.use(new DiscordStrategy({
        clientID: clientID,
        clientSecret: clientSecret,
        callbackURL: 'https://cataloguefbwl.netlify.app/auth/discord/callback',
        scope: ['identify', 'guilds']
    }, (accessToken, refreshToken, profile, done) => {
        profile.accessToken = accessToken;
        return done(null, profile);
    }));
} else {
    console.error("❌ ERREUR CRITIQUE : DISCORD_CLIENT_ID ou DISCORD_CLIENT_SECRET manquant !");
}

// --- ROUTES ---

// Route d'entrée pour la connexion Discord
app.get('/auth/discord', (req, res, next) => {
    console.log("🚀 Lancement de la connexion Discord...");
    passport.authenticate('discord', { 
        callbackURL: 'https://cataloguefbwl.netlify.app/auth/discord/callback'
    })(req, res, next);
});

// Route Callback (Retour de Discord)
app.get('/auth/discord/callback', (req, res, next) => {
    console.log("📩 Retour de Discord reçu ! Vérification des infos...");
    passport.authenticate('discord', { 
        callbackURL: 'https://cataloguefbwl.netlify.app/auth/discord/callback',
        failureRedirect: '/' 
    }, (err, user, info) => {
        if (err) {
            console.error("❌ ERREUR PASSPORT (Retour Discord) :", err);
            return res.redirect('/');
        }
        if (!user) {
            console.error("❌ ÉCHEC AUTHENTIFICATION (Utilisateur non trouvé) :", info);
            return res.redirect('/');
        }
        req.login(user, (loginErr) => {
            if (loginErr) {
                console.error("❌ ERREUR LOGIN (Session) :", loginErr);
                return res.redirect('/');
            }
            console.log("✅ Connexion Passport réussie !");
            next(); // On passe au check des rôles
        });
    })(req, res, next);
}, async (req, res) => {
    try {
        console.log(`🔍 Analyse pour : ${req.user.username}`);

        // ... variables ... (guildId, botToken, etc.)
        const guildId = process.env.DISCORD_GUILD_ID;
        const botToken = process.env.DISCORD_BOT_TOKEN;
        const userId = req.user.id;

        const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
            headers: { Authorization: `Bot ${botToken}` }
        });

        const member = response.data;
        const roles = member.roles || [];
        const isCitoyen = roles.includes(process.env.DISCORD_ROLE_ID_CITOYEN);
        const isStaff = roles.includes(process.env.DISCORD_ROLE_ID_STAFF);
        const targetVoiceId = process.env.DISCORD_VOICE_CHANNEL_ID;
        
        let isInTargetVoice = false;
        try {
            const voiceResponse = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/voice-states/${userId}`, {
                headers: { Authorization: `Bot ${botToken}` }
            }).catch(() => null);

            if (voiceResponse && voiceResponse.data) {
                isInTargetVoice = voiceResponse.data.channel_id === targetVoiceId;
            }
        } catch(e) {}

        const shouldBlock = isCitoyen && isInTargetVoice && !isStaff;
        
        console.log(`📊 VERDICT : isCitoyen=${isCitoyen}, isInTargetVoice=${isInTargetVoice}, isStaff=${isStaff}`);

        if (shouldBlock) {
            console.log("🚫 Refusé : Redirection vers /blocked");
            return res.redirect('/blocked');
        }

        // --- SI AUTORISÉ : ON ENVOIE DIRECTEMENT LE CATALOGUE ---
        console.log("🏁 Autorisé : Envoi direct du catalogue !");
        const filePath = path.join(__dirname, '..', 'Catalogue_RP', 'Catalogue.html');
        
        res.sendFile(filePath, (err) => {
            if (err) {
                console.error("❌ Erreur fichier:", err.message);
                res.status(500).send("Erreur de chargement du catalogue");
            }
        });

    } catch (error) {
        console.error("❌ Erreur check Discord:", error.response?.data || error.message);
        // En cas d'erreur de check, par sécurité on envoie quand même sur le catalogue
        const filePath = path.join(__dirname, '..', 'Catalogue_RP', 'Catalogue.html');
        res.sendFile(filePath);
    }
});

app.get('/blocked', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'blocked.html'));
});

const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.redirect('/');
};

app.get('/streams', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'Catalogue_RP', 'Catalogue.html'));
});

// Export pour Netlify
module.exports.handler = serverless(app);
