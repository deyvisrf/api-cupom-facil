FROM mcr.microsoft.com/playwright:v1.54.1-jammy
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD ["node", "index.js"]