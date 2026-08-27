FROM nginx:alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY frontend/index.html /usr/share/nginx/html/index.html
COPY frontend/sonar-logo.png /usr/share/nginx/html/sonar-logo.png
COPY frontend/README.md /usr/share/nginx/html/README.md
