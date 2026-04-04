require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { Client, GatewayIntentBits, Events } = require('discord.js');
const path = require('path');
const axios = require('axios');

const app = express();
const port = 3000;

console.log('🚀 Démarrage du système...');

// 1. Configuration du Bot Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences
    ]
});

client.once(Events.ClientReady, c => {
    console.log(`✅ BOT DISCORD CONNECTÉ : ${c.user.tag}`);
    console.log('==================================================');
    console.log(`🛡️  Système Anti-Streamhack V2 (Opérationnel)`);
    console.log(`🌐  Lien local : http://localhost:${port}`);
    console.log('==================================================');
});

client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
    console.error("❌ ERREUR CONNEXION BOT :", err.message);
});

// 2. Configuration Express
app.use(session({
    secret: 'secret_anti_streamhack_fbwl',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, 'Catalogue RP')));
app.use('/assets', express.static(path.join(__dirname, 'Catalogue RP', 'assets')));

// 3. Configuration Passport
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: '/' }),
    async (req, res) => {
        try {
            console.log(`\n🔍 Analyse en cours pour : ${req.user.username}`);

            const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
            const member = await guild.members.fetch({ user: req.user.id, force: true });

            const citoyenRoleId = process.env.DISCORD_ROLE_ID_CITOYEN;
            const staffRoleId = process.env.DISCORD_ROLE_ID_STAFF;
            const targetVoiceId = process.env.DISCORD_VOICE_CHANNEL_ID;

            const isCitoyen = member.roles.cache.has(citoyenRoleId);
            const isStaff = member.roles.cache.has(staffRoleId);
            const isInTargetVoice = member.voice.channelId === targetVoiceId;

            console.log(`📊 Stats : Citoyen=${isCitoyen} | Staff=${isStaff} | Vocal=${isInTargetVoice}`);

            const shouldBlock = isCitoyen && isInTargetVoice && !isStaff;

            const webhookURL = process.env.DISCORD_WEBHOOK_URL;
            if (webhookURL) {
                const statusTxt = shouldBlock ? "❌ ACCÈS REFUSÉ" : "✅ ACCÈS AUTORISÉ";
                const embedColor = shouldBlock ? 15548997 : 5763719;

                await axios.post(webhookURL, {
                    embeds: [{
                        title: "🛡️ Gardien Anti-Streamhack",
                        color: embedColor,
                        fields: [
                            { name: "Utilisateur", value: `<@${req.user.id}>`, inline: true },
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
            console.error("❌ Erreur:", error.message);
            res.redirect('/streams');
        }
    }
);

app.get('/blocked', (req, res) => {
    res.sendFile(path.join(__dirname, 'blocked.html'));
});

const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.redirect('/');
};

app.get('/streams', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'Catalogue RP', 'Catalogue.html'));
});

app.listen(port, () => {
    console.log(`📡 Serveur prêt.`);
});