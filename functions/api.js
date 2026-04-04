require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const path = require('path');
const serverless = require('serverless-http');

const app = express();

// Configuration des sessions via Cookies (Adapté pour Netlify/HTTPS)
app.use(cookieSession({
    name: 'session_fbwl',
    keys: ['secret_cookie_anti_streamhack'],
    maxAge: 24 * 60 * 60 * 1000,
    secure: true, // Indispensable sur Netlify (HTTPS)
    sameSite: 'lax',
    httpOnly: true
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

        const guildId = process.env.DISCORD_GUILD_ID;
        const botToken = process.env.DISCORD_BOT_TOKEN;
        const userId = req.user.id;

        // Récupérer les informations du membre dans la guilde
        const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
            headers: { Authorization: `Bot ${botToken}` }
        });

        const member = response.data;
        const citoyenRoleId = process.env.DISCORD_ROLE_ID_CITOYEN;
        const staffRoleId = process.env.DISCORD_ROLE_ID_STAFF;
        const targetVoiceId = process.env.DISCORD_VOICE_CHANNEL_ID;

        const roles = member.roles || [];
        const isCitoyen = roles.includes(citoyenRoleId);
        const isStaff = roles.includes(staffRoleId);
        
        let isInTargetVoice = false;
        try {
            // Vérifier l'état vocal de l'utilisateur
            const voiceResponse = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/voice-states/${userId}`, {
                headers: { Authorization: `Bot ${botToken}` }
            }).catch(() => null);

            if (voiceResponse && voiceResponse.data) {
                isInTargetVoice = voiceResponse.data.channel_id === targetVoiceId;
            }
        } catch(e) {
            console.log("⚠️ Impossible de vérifier l'état vocal (normal si déconnecté).");
        }

        // Logique Anti-Streamhack
        const shouldBlock = isCitoyen && isInTargetVoice && !isStaff;
        
        console.log(`📊 VERDICT : isCitoyen=${isCitoyen}, isInTargetVoice=${isInTargetVoice}, isStaff=${isStaff}`);
        console.log(`🛡️ Blocage nécessaire : ${shouldBlock}`);

        // Webhook (Log)
        const webhookURL = process.env.DISCORD_WEBHOOK_URL;
        if (webhookURL) {
            console.log("📨 Envoi du Webhook...");
            const statusTxt = shouldBlock ? "❌ ACCÈS REFUSÉ" : "✅ ACCÈS AUTORISÉ";
            const embedColor = shouldBlock ? 15548997 : 5763719;

            await axios.post(webhookURL, {
                embeds: [{
                    title: "🛡️ Gardien Anti-Streamhack (Netlify)",
                    color: embedColor,
                    fields: [
                        { name: "Utilisateur", value: `<@${userId}>`, inline: true },
                        { name: "Verdict", value: `**${statusTxt}**`, inline: true }
                    ],
                    timestamp: new Date()
                }]
            }).catch((err) => { console.error("❌ Erreur Webhook:", err.message); });
        }

        if (shouldBlock) {
            console.log("🚫 Redirection vers /blocked");
            res.redirect('/blocked');
        } else {
            console.log("🏁 Redirection vers /streams");
            res.redirect('/streams');
        }

    } catch (error) {
        console.error("❌ Erreur lors du check Discord:", error.response?.data || error.message);
        res.redirect('/streams'); // Par défaut on laisse passer si l'API Discord est injoignable (pour éviter de bloquer tout le monde)
    }
});

app.get('/blocked', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'blocked.html'));
});

const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) {
        console.log("🔓 Utilisateur authentifié : " + req.user.username);
        return next();
    }
    console.warn("🔒 Accès refusé : Utilisateur non authentifié, redirection vers /");
    res.redirect('/');
};

app.get('/streams', isAuthenticated, (req, res) => {
    const filePath = path.join(__dirname, '..', 'Catalogue_RP', 'Catalogue.html');
    console.log("📂 Tentative d'envoi du catalogue : " + filePath);
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error("❌ Erreur envoi fichier :", err.message);
            res.status(500).send("Erreur de chargement du catalogue");
        }
    });
});

// Export pour Netlify
module.exports.handler = serverless(app);
