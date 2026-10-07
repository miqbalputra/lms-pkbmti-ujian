FROM node:24-alpine
WORKDIR /srv
COPY collaboration/package*.json ./collaboration/
RUN cd collaboration && npm ci --omit=dev
COPY collaboration ./collaboration
COPY shared ./shared
RUN ln -s /srv/collaboration/node_modules /srv/node_modules
USER node
WORKDIR /srv/collaboration
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:1234/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
