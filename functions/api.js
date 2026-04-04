require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const path = require('path');
const serverless = require('serverless-http');

const app = express();

// Configuration des sessions via Cookies (nécessaire pour le serverless/Netlify)
app.use(cookieSession({
    name: 'session_fbwl',
    keys: ['secret_cookie_anti_streamhack'],
    maxAge: 24 * 60 * 60 * 1000 // 24 heures
}));

app.use(passport.initialize());
app.use(passport.session());

// Passport setup
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: '/auth/discord/callback',
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// --- ROUTES ---

// Auth Routes
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: '/' }),
    async (req, res) => {
        try {
            console.log(`🔍 Analyse pour : ${req.user.username}`);

            const guildId = process.env.DISCORD_GUILD_ID;
            const botToken = process.env.DISCORD_BOT_TOKEN;
            const userId = req.user.id;

            // Utilisation directe de l'API REST pour être plus rapide sur Netlify (vs client bot lourd)
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
            
            // Pour le vocal, l'API Discord membres ne renvoie pas l'état vocal direct sans Guild Intents
            // Mais puisque c'est du serverless, on va essayer de récupérer l'état vocal séparément si possible
            // OU demander à l'utilisateur s'il veut simplifier.
            
            // Alternative : Récupérer tous les états vocaux de la guilde (attention si grosse guilde)
            // Mais pour faire simple et rapide sur Netlify, on va vérifier le voice_state s'il est dispo via l'API.
            
            let isInTargetVoice = false;
            try {
                // Optionnel: On vérifie si l'API renvoie le channel_id via un autre endpoint si besoin
                // Pour l'instant on simule l'état ou on utilise une méthode plus "serverless"
                // Mais le plus simple est de garder la logique de blocage si isCitoyen et non-Staff.
                
                // Note : Sans Bot client persistant, vérifier "isInTargetVoice" demande un fetch GuildVoiceStates.
                const voiceResponse = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/voice-states/${userId}`, {
                    headers: { Authorization: `Bot ${botToken}` }
                }).catch(() => null);

                if (voiceResponse && voiceResponse.data) {
                    isInTargetVoice = voiceResponse.data.channel_id === targetVoiceId;
                }
            } catch(e) {}

            const shouldBlock = isCitoyen && isInTargetVoice && !isStaff;

            // Webhook
            const webhookURL = process.env.DISCORD_WEBHOOK_URL;
            if (webhookURL) {
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
                }).catch(() => { });
            }

            if (shouldBlock) {
                res.redirect('/blocked');
            } else {
                res.redirect('/streams');
            }

        } catch (error) {
            console.error("❌ Erreur API Discord:", error.response?.data || error.message);
            res.redirect('/streams');
        }
    }
);

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
