import streamlit as st
import pandas as pd
from data_processor import process_data

import os

st.set_page_config(page_title="HubSpot Table Editor", layout="wide")

# Get the password from secrets
try:
    CORRECT_PASSWORD = st.secrets["app"]["password"]
except (FileNotFoundError, KeyError):
    st.error("🚨 Configuration Error: The app password is not set in the Streamlit Cloud Secrets!")
    st.stop()

def check_password():
    """Returns `True` if the user had the correct password."""
    # 1. Check if already authenticated in this session
    if st.session_state.get("password_correct", False):
        return True

    # 2. Check if the password was passed in the URL (so she can bookmark it)
    if st.query_params.get("pwd") == CORRECT_PASSWORD:
        st.session_state["password_correct"] = True
        return True

    # 3. Otherwise, show a password input box
    st.title("🔒 Login Required")
    st.write("Please enter the password to access the automation.")
    
    password = st.text_input("Password", type="password")
    
    if password:
        if password == CORRECT_PASSWORD:
            st.session_state["password_correct"] = True
            st.rerun()
        else:
            st.error("😕 Password incorrect")
            
    return False

if not check_password():
    st.stop()  # Stop the app from running the rest of the code until authenticated

# --- MAIN APP LOGIC BELOW ---
st.title("HubSpot Table Editor")
st.write("Upload a CSV or Excel file containing your leads to process them for HubSpot.")

# Provide the magic link for her to bookmark
st.success(f"✅ Logged in! **[Click here and bookmark this link](/?pwd={CORRECT_PASSWORD})** to never have to type the password again.")

uploaded_files = st.file_uploader("Choose CSV or Excel files", type=["csv", "xlsx"], accept_multiple_files=True)

if uploaded_files:
    # Read and combine all files
    try:
        all_dfs = []
        for file in uploaded_files:
            if file.name.endswith('.csv'):
                df = pd.read_csv(file)
            else:
                df = pd.read_excel(file)
            all_dfs.append(df)
            
        combined_df = pd.concat(all_dfs, ignore_index=True)
            
        st.subheader(f"Original Data (Combined - {len(uploaded_files)} files)")
        st.dataframe(combined_df, height=300)
        
        if st.button("Process Data"):
            with st.spinner("Processing data (this may take a moment if calling APIs)..."):
                processed_df = process_data(combined_df)
                st.session_state['processed_df'] = processed_df
                
    except Exception as e:
        st.error(f"Error reading files: {e}")

if 'processed_df' in st.session_state:
    st.subheader("Processed Data (Review & Edit)")
    st.write("Review the data below. Cells with missing data might need manual updates. You can edit the table directly.")
    
    # Use st.data_editor so the user can modify the dataframe
    edited_df = st.data_editor(st.session_state['processed_df'], num_rows="dynamic")
    
    st.download_button(
        label="Download for HubSpot (CSV)",
        data=edited_df.to_csv(index=False).encode('utf-8'),
        file_name="hubspot_ready_leads.csv",
        mime="text/csv"
    )
