# Objectif unique

Une extension doit avoir un seul objectif qui soit à la fois précis et facile à comprendre.

## Justification de l'autorisation `storage`

L’extension utilise l’autorisation **storage** pour enregistrer les paramètres de l’utilisateur (par exemple, le tarif horaire, la devise préférée et les préférences d’affichage). Ces données sont stockées localement et ne sont jamais partagées avec des serveurs externes, garantissant ainsi la confidentialité tout en offrant une expérience personnalisée.

## Justification de l'autorisation d'accès à l'hôte

L’extension nécessite l’accès aux pages de Google Calendar (`https://calendar.google.com/*`) afin d’injecter le calcul du coût des réunions directement dans l’interface du calendrier. Aucun autre domaine n’est accédé, et les scripts n’effectuent aucune requête réseau en dehors de cet hôte.
